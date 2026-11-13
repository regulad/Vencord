/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { MediaEngineStore } from "@webpack/common";

const settings = definePluginSettings({
    targetLoudness: {
        type: OptionType.SLIDER,
        description: "Loudness every user is adjusted towards, in dBFS",
        markers: makeRange(-40, -5, 5),
        default: -8.5,
        stickToMarkers: false
    },
    maxBoost: {
        type: OptionType.SLIDER,
        description: "Most a user can be turned up, in dB",
        markers: makeRange(0, 20, 4),
        default: 12,
        stickToMarkers: false
    },
    maxCut: {
        type: OptionType.SLIDER,
        description: "Most a user can be turned down, in dB",
        markers: makeRange(0, 20, 4),
        default: 12,
        stickToMarkers: false
    },
    window: {
        type: OptionType.SLIDER,
        description: "How many seconds of a user's recent talking their loudness is measured over. Longer is steadier but slower to adapt",
        markers: [5, 15, 30, 60, 120],
        default: 15,
        stickToMarkers: false
    },
    speechThreshold: {
        type: OptionType.SLIDER,
        description: "Audio quieter than this, in dBFS, doesn't count as talking, so background noise from open mics doesn't make someone seem quieter",
        markers: makeRange(-60, -20, 10),
        default: -35,
        stickToMarkers: false
    }
});

// discord-types doesn't cover voice connection stats, so only what this plugin uses is typed here
interface InboundStats {
    type: "audio" | "video";
    // Peak level of the received audio before the user's volume is applied, 0-1
    audioLevel: number;
    // 10ms frames decoded from packets the user sent. It stops while they're squelched
    decodingNormal: number;
}

interface VoiceConnection {
    localVolumes: Record<string, number | undefined>;
    setLocalVolume(userId: string, volume: number | undefined): void;
    getStats(): Promise<{ rtp: { inbound: Record<string, InboundStats[]>; }; } | null>;
}

interface MediaEngine {
    eachConnection(callback: (connection: VoiceConnection) => void, context: "default"): void;
}

interface UserLoudness {
    decodingNormal: number;
    // Talking measured so far, in seconds
    seconds: number;
    // Mean squared level of it, weighted towards the last window seconds
    power: number;
    gainDb: number;
    // What the voice engine was last given
    appliedGainDb: number;
}

const POLL_INTERVAL_MS = 100; // About how often the native level meter refreshes
const FRAME_SECONDS = 0.01;
const WARMUP_SECONDS = 3;
const SLEW_DB_PER_POLL = 2 * POLL_INTERVAL_MS / 1000;
const MIN_STEP_DB = 0.5;

const logger = new Logger("AutoVolume");

const users = new Map<string, UserLoudness>();

const getMediaEngine = () => MediaEngineStore.getMediaEngine() as unknown as MediaEngine;

function updateGain(connection: VoiceConnection, userId: string, user: UserLoudness) {
    const { targetLoudness, maxBoost, maxCut } = settings.store;

    const loudness = 10 * Math.log10(Math.max(user.power, 1e-10));
    const targetGainDb = user.seconds < WARMUP_SECONDS
        ? 0
        : Math.min(Math.max(targetLoudness - loudness, -maxCut), maxBoost);

    user.gainDb += Math.min(Math.max(targetGainDb - user.gainDb, -SLEW_DB_PER_POLL), SLEW_DB_PER_POLL);
    if (Math.abs(user.gainDb - user.appliedGainDb) < MIN_STEP_DB) return;

    user.appliedGainDb = user.gainDb;
    // Sends the volume to the voice engine again, which applies the gain through the patched getLocalVolume
    connection.setLocalVolume(userId, connection.localVolumes[userId]);
}

async function measure(connection: VoiceConnection) {
    const stats = await connection.getStats();
    if (!stats) return;

    for (const [userId, streams] of Object.entries(stats.rtp.inbound)) {
        const audio = streams.find(s => s.type === "audio");
        if (!audio) continue;

        const user = users.get(userId);
        if (!user) {
            users.set(userId, { decodingNormal: audio.decodingNormal, seconds: 0, power: 0, gainDb: 0, appliedGainDb: 0 });
            continue;
        }

        // Negative after the user reconnects, which resets the counter
        const seconds = (audio.decodingNormal - user.decodingNormal) * FRAME_SECONDS;
        user.decodingNormal = audio.decodingNormal;

        // Open mics keep sending background noise between sentences, which shouldn't count as talking
        if (seconds > 0 && audio.audioLevel >= 10 ** (settings.store.speechThreshold / 20)) {
            user.seconds += seconds;
            // A plain average until a window's worth has been measured, then a moving one
            user.power += seconds / Math.min(user.seconds, settings.store.window) * (audio.audioLevel ** 2 - user.power);
        }

        updateGain(connection, userId, user);
    }
}

let pollInterval: ReturnType<typeof setInterval> | undefined;
let polling = false;

async function poll() {
    if (polling) return;
    polling = true;

    try {
        const connections: VoiceConnection[] = [];
        getMediaEngine().eachConnection(connection => connections.push(connection), "default");
        await Promise.all(connections.map(measure));
    } catch (e) {
        logger.error("Failed to measure loudness", e);
    } finally {
        polling = false;
    }
}

export default definePlugin({
    name: "AutoVolume",
    description: "Adjusts everyone in voice chats to the same loudness. Their user volume is applied on top",
    authors: [Devs.regulad],
    tags: ["Voice"],
    settings,

    patches: [
        {
            find: "Ignoring attempt to recreate user",
            replacement: {
                match: /(?<=getLocalVolume\((\i)\)\{.+?return )(.+?\/100)(?=\})/,
                replace: "($2)*$self.gainFor($1,this.context)"
            }
        }
    ],

    gainFor(userId: string, context: string) {
        const user = context === "default" ? users.get(userId) : undefined;
        return user ? 10 ** (user.appliedGainDb / 20) : 1;
    },

    start() {
        pollInterval = setInterval(poll, POLL_INTERVAL_MS);
    },

    stop() {
        clearInterval(pollInterval);

        const adjusted = [...users].filter(([, user]) => user.appliedGainDb !== 0);
        users.clear();
        getMediaEngine().eachConnection(connection => {
            for (const [userId] of adjusted) connection.setLocalVolume(userId, connection.localVolumes[userId]);
        }, "default");
    }
});
