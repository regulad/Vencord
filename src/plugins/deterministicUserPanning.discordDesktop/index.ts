/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { hash } from "@intrnl/xxhash64";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import type { VoiceState } from "@vencord/discord-types";
import { MediaEngineStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

const settings = definePluginSettings({
    maxSpread: {
        type: OptionType.SLIDER,
        description: "How far left and right of center users can be placed, in degrees",
        markers: makeRange(15, 90, 15),
        default: 65,
        stickToMarkers: false,
        onChange() {
            // The key is only set while the plugin is running and positioning someone
            if (!layoutKey) return;
            layoutKey = "";
            updateLayout();
        }
    }
});

// discord-types doesn't cover the spatial audio API yet, so only what this plugin uses is typed here
interface Vector3 {
    x: number;
    y: number;
    z: number;
}

type UsersMergedListener = (users: { id: string; }[]) => void;

interface VoiceConnection {
    context: "default" | "stream";
    setUserPosition(userId: string, position: Vector3): void;
    on(event: "users-merged", listener: UsersMergedListener): void;
    removeListener(event: "users-merged", listener: UsersMergedListener): void;
}

interface MediaEngine {
    supports(feature: "SPATIAL_AUDIO"): boolean;
    on(event: "connection", listener: (connection: VoiceConnection) => void): void;
    removeListener(event: "connection", listener: (connection: VoiceConnection) => void): void;
    eachConnection(callback: (connection: VoiceConnection) => void, context: "default"): void;
}

type Layout = [userId: string, position: Vector3][];

const logger = new Logger("DeterministicUserPanning");

// Where Discord puts users it has no position for
const DEFAULT_POSITION: Vector3 = { x: 0, y: 0, z: -1 };

const getMediaEngine = () => MediaEngineStore.getMediaEngine() as unknown as MediaEngine;

function getChannelVoiceStates() {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId) return [];

    const myId = UserStore.getCurrentUser().id;
    return Object.values(VoiceStateStore.getVoiceStatesForChannel(channelId)).filter(s => s.userId !== myId);
}

// Deafened users, and users who are muted by the server, by themselves or locally, don't take up a spot
const isLeftOut = (s: VoiceState) => s.isVoiceDeafened() || s.isVoiceMuted() || MediaEngineStore.isLocalMute(s.userId);

// Spreads the other users in the channel evenly over an arc in front of the listener,
// ordered by a hash of their id so every client puts them in the same order.
// Users who are left out go back to the default position.
// Positions are relative to the listener: x is right, y is up, -z is ahead
function getLayout(voiceStates = getChannelVoiceStates()): Layout {
    const userIds = voiceStates
        .filter(s => !isLeftOut(s))
        .map(s => [s.userId, hash(s.userId)] as const)
        .sort(([, a], [, b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([id]) => id);

    const maxAzimuth = settings.store.maxSpread * Math.PI / 180;
    const fan = userIds.map((userId, i): Layout[number] => {
        const azimuth = ((i + 0.5) / userIds.length - 0.5) * 2 * maxAzimuth;
        return [userId, { x: Math.sin(azimuth), y: 0, z: -Math.cos(azimuth) }];
    });
    const leftOut = voiceStates
        .filter(isLeftOut)
        .map((s): Layout[number] => [s.userId, DEFAULT_POSITION]);

    return [...fan, ...leftOut];
}

function applyLayout(connection: VoiceConnection, layout: Layout) {
    try {
        for (const [userId, position] of layout) connection.setUserPosition(userId, position);
    } catch (e) {
        logger.error("Failed to set user positions", e);
    }
}

let layoutKey = "";

// Every user joining, leaving, or being left out or let back in moves everyone else. The stores also change for
// plenty else, so only lay out again when one of those happened
function updateLayout() {
    const voiceStates = getChannelVoiceStates();
    const key = voiceStates.map(s => s.userId + (isLeftOut(s) ? "-" : "")).sort().join();
    if (key === layoutKey) return;

    layoutKey = key;
    const layout = getLayout(voiceStates);
    getMediaEngine().eachConnection(connection => applyLayout(connection, layout), "default");
}

const usersMergedListeners = new WeakMap<VoiceConnection, UsersMergedListener>();

// Positions are dropped for users a connection hasn't created yet. users-merged is emitted whenever it creates some,
// including those created before it finished connecting.
// Listeners aren't called with the connection as this, so each connection gets its own
function listen(connection: VoiceConnection) {
    const listener: UsersMergedListener = () => applyLayout(connection, getLayout());
    usersMergedListeners.set(connection, listener);
    connection.on("users-merged", listener);
}

function onConnection(connection: VoiceConnection) {
    if (connection.context === "default") listen(connection);
}

export default definePlugin({
    name: "DeterministicUserPanning",
    description: "Spreads everyone in your voice chat who isn't muted or deafened across the space in front of you, in the same order on every client, using Discord's spatial audio",
    authors: [Devs.regulad],
    tags: ["Voice"],
    settings,

    patches: [
        {
            // Spatial audio is behind an experiment. Keep it on unless something overrides it; it still needs a supporting voice engine
            find: 'displayName="SpatialAudioStore"',
            replacement: {
                match: /(?<=\.isSpatial=\(\i\.isSpatial\?\?)/,
                replace: "!0??"
            }
        }
    ],

    start() {
        const engine = getMediaEngine();
        if (!engine.supports("SPATIAL_AUDIO")) {
            showNotification({
                title: "DeterministicUserPanning",
                body: "Discord's voice engine doesn't support spatial audio on this device, so users won't be positioned."
            });
        }

        engine.on("connection", onConnection);
        engine.eachConnection(listen, "default");
        VoiceStateStore.addChangeListener(updateLayout);
        MediaEngineStore.addChangeListener(updateLayout);
        updateLayout();
    },

    stop() {
        const engine = getMediaEngine();
        engine.removeListener("connection", onConnection);
        VoiceStateStore.removeChangeListener(updateLayout);
        MediaEngineStore.removeChangeListener(updateLayout);
        layoutKey = "";

        const reset: Layout = getChannelVoiceStates().map(s => [s.userId, DEFAULT_POSITION]);
        engine.eachConnection(connection => {
            const listener = usersMergedListeners.get(connection);
            if (listener) connection.removeListener("users-merged", listener);
            applyLayout(connection, reset);
        }, "default");
    }
});
