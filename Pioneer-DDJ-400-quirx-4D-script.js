// Pioneer-DDJ-400-script.js
// ****************************************************************************
// * Mixxx mapping script file for the Pioneer DDJ-400 with 4-deck switching.
// * Authors: Quirx, Warker, nschloe, dj3730, jusko
// * Reviewers: ?
// * Manual: tbd
// ****************************************************************************
//
// Most of the code was written from scratch, but some residuals from the original DDJ-400
// mapping might remain, so the authors deserve to be mentioned.
//
// Naming is a bit messy here since we have two hardware decks to control 4 software decks.
// In the XML file, the hardware decks have group names 'L' and 'R' which are then mapped
// to software decks in javascript. To add confusion, the Mixxx groups are called '[ChannelX]'.
//
// Functions that handle regular incoming MIDI messages have a signature of
//   f(channel, control, value, status, group),
// where 'channel' is taken from the midi message and are always 0 or 1 in the cases where
// we have to map hardware decks to software decks.
// On the other hand, 'group' is given by the group XML tag, which is 'L' or 'R'. So they
// are pretty much redundant.
//
// For output mappings however, our functions get called by Mixxx and there, the signature
// is
//   f(value, group, control),
// where 'group' is the Mixxx group name, i.e. '[ChannelX]' in the cases where we have to
// map a software deck to a hardware deck.
//
// This is all very annoying, especially since the naming is not consistent.
// I am trying to consistently use
//   - deck: software deck [1-4]
//   - channel: hardware deck index [0-1]
//   - group: depends on context, either
//     - 'L'/'R' (controller -> computer) or
//     - '[ChannelX]' (computer -> controller).
// Since 'group' and 'channel' are redundant for controller -> computer, I will prefer
//   - channel for controller -> computer and 
//   - group for computer -> controller.

//                       +------------- Controller -------------+
//                       |                                      |
//                       | channel 0                  channel 1 |
//                       |    |                           |     |
//                       +----|---------------------------|-----+
// PioneerDDJ400.state        |                           |
// .channel_mapping          [0]                         [1]
//                           / \                         / \
//                          /   \          --------------   \
//                         /     --------------              \
//                        /              /     \              \
//                       /              /       \              \
//                      /              /         \              \
// Decks:        deck 0          deck 1          deck 2          deck 3
//                  |               |               |               |
//                  |               |               |               |
// Groups:     [Channel1]      [Channel2]      [Channel3]      [Channel4]

// Concept
// The concept builds upon some central elements:
//   - connections
//   - deck states
//   - timers.
// The connections are used to update the deck states in javascript when they change in Mixxx.
// There are always two sets of active connections, one for each hardware channel. When the
// hardware channel is switched, the connections are closed and new ones set up. E.g. when
// switching from [Channel1]/[Channel2] to [Channel3]/[Channel4], the connections for the
// former are disconnected and then, the connections for the latter are connected. This way,
// the script receives only updates from the active channel groups.
//
// The deck states are kept in javascript if they are not kept by the engine. Redundant
// state keeping is avoided to reduce bugs. This e.g. covers loop in/loop out adjust, which
// is done entirely through scripting. The Mixxx engine does not know a "loop in adjust active"
// state. When switching channels, states are used to restore the correct controller status
// for the now-active channels. This covers things like LEDs, timers for LEDs that should
// be flashing etc.
//
// Timers (and other stuff?) mostly exist to make a LED blink. They exist for each hardware
// channel. When the channel is switched, they are terminated. New timers and possibly other
// things are created for the now-active channels.
//
// Oddities:
//   - There is only one effect light but we use up to two effect units.
//     The effect light follows the active effect unit. The active effect unit is determined
//     by the last shift button that was pressed. The left shift button sets the effect unit
//     associated with the left channel's deck as active, while the right shift button
//     sets the effect unit associated with the right channel's deck as active.
//     By default, the decks 0/1 are associated with the first effect unit and the decks
//     2/3 are associated with the second one.
//     Also, the effect channel select slider selects the channel for the active effect unit,
//     but only allows to select decks that are associated with the unit. This is super
//     confusing at first, but it is safer to use than other options. Basically, it makes
//     sense when both controller channels are switched at the same time. Then, FX unit 2
//     is for the alternate decks, and FX unit 1 for the primary decks.
//
// Suggestions:
//   - Being able to switch the decks independently is very confusing as you easily lose
//     track of which side of the controller manages which deck.
//     You can set always_toggle_both to true to simplify this somewhat.
//   - Long-press loop-in for an instant 4-beat-loop currently requires
//     merging of PR #4491. You can use this mapping without the PR by commenting the line
//           engine.setValue(group, 'beatloop_keep_loopin', 4);
//     in the function PioneerDDJ400.loop_in_long (The long-press 4-beat feature will
//     not work then).
//
// Features:
//   - Decks are switched by double-pressing the shift button. Only the deck on the side
//     of the shift button is switched unless always_toggle_both = true (default false).
//   - The decks can alternatively be switched via the beatjump + shift + first pad.
//     The first pad is lit when pressing shift in beatjump mode if the channel is
//     currently associated with the main deck for this channel.
//   - Headphone cue split can be toggled via beatjump + shift + second pad. It is lit if
//     headphone cue split is active. This control is identical for both controller channels.
//   - Keylock can be toggled via beatjump + shift + 4th pad. The pad is lit if keylock
//     is on for the deck.
//   - Beatjump size can be scaled using beatjump + shift + 7th/8th pad. The 7th pad
//     decreases the sizes by a factor of 1/16, the 8th increases by a factor of 16.
//     The pads are lit if further decrease/increase is possible (currently only one scaling
//     step in either direction is allowed, this gives a range from 1/16 to 512
//     which *should* be enough for most people).
//   - Quantize can be toggled with shift+headphone cue. Pressing shift highlights those
//     buttons according to the deck's quantize state.
//   - Vinly break is implemented as pad 1 in PAD FX 1. The break speed can be adjusted via
//     brake_speed (default 20), higher values = faster braking.
//   - Loop in/out adjust works by just pressing the in/out buttons while a loop is active.
//     Adjustment is performed by rotating the jogwheel. Loop adjust mode exits automatically
//     when switching decks on the controller channel where loop adjust is in use. To normally
//     exit loop in or out adjust, just press in or out again, respectively.
//   - Effects are selected by the FX SELECT button (next effect, +SHIFT previous effect).
//     Effects are cycled using the beat </> buttons. The active effect unit is determined by
//     the deck whose shift button was last pressed.

var PioneerDDJ400 = {};

PioneerDDJ400.constants = {
    default_effect_unit: [1, 1, 2, 2],
    primary_deck: [0, 1],
    sampler_groups: [
        ['[Sampler1]', '[Sampler2]', '[Sampler3]', '[Sampler4]', '[Sampler5]', '[Sampler6]', '[Sampler7]', '[Sampler8]',],
        ['[Sampler9]', '[Sampler10]', '[Sampler11]', '[Sampler12]', '[Sampler13]', '[Sampler14]', '[Sampler15]', '[Sampler16]',],
        ['[Sampler1]', '[Sampler2]', '[Sampler3]', '[Sampler4]', '[Sampler5]', '[Sampler6]', '[Sampler7]', '[Sampler8]',],
        ['[Sampler9]', '[Sampler10]', '[Sampler11]', '[Sampler12]', '[Sampler13]', '[Sampler14]', '[Sampler15]', '[Sampler16]',],
    ],
    loop_adjust_multiply: 50,
    always_toggle_both: false,
    backspin_length: 0x20, /* This is a setting sent to the controller. 0x00 is short, 0x10 is normal, 0x20 is long. */
    brake_speed: 20,
    bend_scale: 0.8,
    fast_seek_scale: 150,
    vinyl_mode: true,
    jog_alpha: 1.0 / 8,
    jog_beta: (1.0 / 8) / 32,
    tempo_range: [0.06, 0.1, 0.16, 0.25],
    beatloop_sizes: [0.25, 0.5, 1, 2, 4, 8, 16, 32],
    beatjump_sizes: [-1, 1, -2, 2, -4, 4, -8, 8],
    beatjump_scalefac: 16,
    quick_jump_size: 32,
    times: {
        loop_active: 500,
        loop_adjust: 250,
        double_press: 290,
    },
    loop_modifiers: {
        none: 0,
        adjust_in: 1,
        adjust_out: 2,
    },
    lights: {
        vu_meter: {
            status: 0xB0,
            data1: 0x02,
        },
        beat_fx: {
            status: 0x94,
            data1: 0x47,
        },
        shift_beat_fx: {
            status: 0x94,
            data1: 0x43,
        },
        play_pause: {
            status: 0x90,
            data1: 0x0B,
        },
        shift_play_pause: {
            status: 0x90,
            data1: 0x47,
        },
        cue: {
            status: 0x90,
            data1: 0x0C,
        },
        shift_cue: {
            status: 0x90,
            data1: 0x48,
        },
        load_animation: {
            status: 0x9F,
            data1: 0x00,
        },
        reloop: {
            status: 0x90,
            data1: 0x4D,
        },
        shift_reloop: {
            status: 0x90,
            data1: 0x50,
        },
        loop_in: {
            status: 0x90,
            data1: 0x10,
        },
        shift_loop_in: {
            status: 0x90,
            data1: 0x4C,
        },
        loop_out: {
            status: 0x90,
            data1: 0x11,
        },
        shift_loop_out: {
            status: 0x90,
            data1: 0x4E,
        },
        beatsync: {
            status: 0x90,
            data1: 0x58,
        },
        shift_beatsync: {
            status: 0x90,
            data1: 0x60,
        },
        headphone_cue: {
            status: 0x90,
            data1: 0x54,
        },
        shift_headphone_cue: {
            status: 0x90,
            data1: 0x68,
        },
    },
    filter: {
        left: {
            lsb: {
                status: 0xB6,
                data1: 0x37,
            },
            msb: {
                status: 0xB6,
                data1: 0x17,
            },
        },
        right: {
            lsb: {
                status: 0xB6,
                data1: 0x38,
            },
            msb: {
                status: 0xB6,
                data1: 0x18,
            },
        },
    },
    pad_modes: {
        hot_cue: 0x00,
        beat_loop: 0x60,
        beat_jump: 0x20,
        sampler: 0x30,
        keyboard: 0x40,
        fx_1: 0x10,
        fx_2: 0x50,
        key_shift: 0x70,
    },
    controller_settings: {
        backspin_length: {
            status: 0xBF,
            data1: 0x45,
        }
    },
    output_control_to_function: {},
};

PioneerDDJ400.state = {
    channel_mapping: [0, 1],
    connections: [{}, {}],
    timers: [{}, {}],
    channel: [{}, {}],
    deck: [{}, {}, {}, {}],
    persistent_connections: {},
    last_shift_button_pressed: 0,
};

PioneerDDJ400.internal = {
    // helpers
    group_to_channel: function (group) {
        return PioneerDDJ400.internal.deck_to_channel(PioneerDDJ400.internal.group_to_deck(group));
    },
    padchannel_to_channel: function (padchannel) {
        return (padchannel >= 9) ? 1 : 0;
    },
    padchannel_has_shift: function (padchannel) {
        return (padchannel & 0x01) ? false : true;
    },
    channel_to_deck: function (channel) {
        return PioneerDDJ400.state.channel_mapping[channel];
    },
    channel_to_group: function (channel) {
        return PioneerDDJ400.internal.deck_to_group(PioneerDDJ400.internal.channel_to_deck(channel));
    },
    group_to_deck: function (group) {
        switch (group) {
            case '[Channel1]':
                return 0;
            case '[Channel2]':
                return 1;
            case '[Channel3]':
                return 2;
            case '[Channel4]':
                return 3;
            default:
                return 0;
        };
    },
    deck_to_group: function (deck) {
        return '[Channel' + (deck + 1) + ']';
    },
    deck_to_channel: function (deck) {
        if (PioneerDDJ400.state.channel_mapping[0] == deck) {
            return 0;
        }

        if (PioneerDDJ400.state.channel_mapping[1] == deck) {
            return 1;
        }

        print('Warning: called deck_to_channel(' + deck + ') but deck not active?!');
        return 0;
    },
    get_num_decks: function () {
        return engine.getValue('[Master]', 'num_decks');
    },
    next_deck: function (_channel, old_deck) {
        const it = PioneerDDJ400.internal;
        var num_decks = it.get_num_decks();
        return (old_deck + 2) % num_decks;
    },
    is_deck_active: function (deck) {
        return PioneerDDJ400.state.channel_mapping[0] == deck ||
            PioneerDDJ400.state.channel_mapping[1] == deck;
    },
    is_group_active: function (group) {
        const it = PioneerDDJ400.internal;
        return it.is_deck_active(it.group_to_deck(group));
    },
    update_light: function (channel, midi_out, active) {
        midi.sendShortMsg(midi_out.status + channel,
            midi_out.data1,
            active ? 0x7F : 0);
    },
    // outputs
    set_backspin_length: function (length) {
        const cmd = PioneerDDJ400.constants.controller_settings.backspin_length;
        midi.sendShortMsg(cmd.status, cmd.data1, length);
    },
    vu_meter_update: function (value, group) {
        var scaled_value = value * 140;
        midi.sendShortMsg(PioneerDDJ400.constants.lights.vu_meter.status + PioneerDDJ400.internal.group_to_channel(group),
            PioneerDDJ400.constants.lights.vu_meter.data1,
            scaled_value);
    },
    track_loaded_animation: function (value, group) {
        midi.sendShortMsg(PioneerDDJ400.constants.lights.load_animation.status,
            PioneerDDJ400.internal.group_to_channel(group),
            value > 0 ? 0x7f : 0x00);
    },
    update_indicator: function (value, group, midi_out, shift_midi_out) {
        const it = PioneerDDJ400.internal;
        if (!it.is_group_active(group)) {
            return;
        }

        var channel = it.group_to_channel(group);
        it.update_light(channel, midi_out, value);
        if (shift_midi_out) {
            it.update_light(channel, shift_midi_out, value);
        }
    },
    play_indicator: function (value, group) {
        PioneerDDJ400.internal.update_indicator(value, group, PioneerDDJ400.constants.lights.play_pause, PioneerDDJ400.constants.lights.shift_play_pause);
    },
    cue_indicator: function (value, group) {
        PioneerDDJ400.internal.update_indicator(value, group, PioneerDDJ400.constants.lights.cue, PioneerDDJ400.constants.lights.shift_cue);
    },
    beatsync_update: function (value, group) {
        PioneerDDJ400.internal.update_indicator(value, group, PioneerDDJ400.constants.lights.beatsync, false);
    },
    beatmaster_update: function (value, group) {
        PioneerDDJ400.internal.update_indicator(value, group, PioneerDDJ400.constants.lights.shift_beatsync, false);
    },
    headphone_cue_update: function (value, group) {
        PioneerDDJ400.internal.update_indicator(value, group, PioneerDDJ400.constants.lights.headphone_cue, false);
    },
    quantize_update: function (value, group) {
        PioneerDDJ400.internal.update_indicator(value, group, PioneerDDJ400.constants.lights.shift_headphone_cue, false);
    },
    keylock_update: function (value, group) {
        const it = PioneerDDJ400.internal;
        if (!it.is_group_active(group)) {
            return;
        }

        var channel = it.group_to_channel(group);
        it.set_pad_light(PioneerDDJ400.constants.pad_modes.beat_jump, channel, 3, true, value ? 0x7f : 0x00);
    },
    // loop
    get_loop_active: function (group) {
        return engine.getValue(group, "loop_enabled");
    },
    set_reloop_light: function (channel, value) {
        const it = PioneerDDJ400.internal;
        it.update_light(channel, PioneerDDJ400.constants.lights.reloop, value);
        it.update_light(channel, PioneerDDJ400.constants.lights.shift_reloop, value);
    },
    update_loop_inout_lights: function (channel) {
        const it = PioneerDDJ400.internal;
        const cst = PioneerDDJ400.constants;
        const timer_id = 'loop_inout_blink';

        var blink_state = false;

        // stop blink in any case (assume we change state, otherwise might flicker a bit)
        stop_blink = function () {
            if (PioneerDDJ400.state.timers[channel][timer_id] != undefined) {
                engine.stopTimer(PioneerDDJ400.state.timers[channel][timer_id]);
                PioneerDDJ400.state.timers[channel][timer_id] = undefined;
            }
        }

        const loop_active = it.get_loop_active(it.channel_to_group(channel));
        if (!loop_active) {
            stop_blink();
            it.update_light(channel, cst.lights.loop_in, true);
            it.update_light(channel, cst.lights.loop_out, true);
            it.update_light(channel, cst.lights.shift_loop_in, true);
            it.update_light(channel, cst.lights.shift_loop_out, true);
            PioneerDDJ400.state.channel[channel].current_loop_modifier = cst.loop_modifiers.none;
            return;
        }

        const modifier = it.get_loop_adjust_state(it.channel_to_deck(channel));
        const timer_present = PioneerDDJ400.state.timers[channel][timer_id] !== undefined;
        const cur_loop_mod = PioneerDDJ400.state.channel[channel].current_loop_modifier;
        switch (modifier) {
            default:
            case cst.loop_modifiers.none:
                if (cur_loop_mod == cst.loop_modifiers.none && timer_present) {
                    return;
                }
                stop_blink();
                PioneerDDJ400.state.timers[channel][timer_id] = engine.beginTimer(cst.times.loop_active, function () {
                    blink_state = !blink_state;
                    it.update_light(channel, cst.lights.loop_in, blink_state);
                    it.update_light(channel, cst.lights.loop_out, blink_state);
                    it.update_light(channel, cst.lights.shift_loop_in, blink_state);
                    it.update_light(channel, cst.lights.shift_loop_out, blink_state);
                });
                it.update_light(channel, cst.lights.loop_in, false);
                it.update_light(channel, cst.lights.loop_out, false);
                it.update_light(channel, cst.lights.shift_loop_in, false);
                it.update_light(channel, cst.lights.shift_loop_out, false);
                PioneerDDJ400.state.channel[channel].current_loop_modifier = cst.loop_modifiers.none;
                break;
            case cst.loop_modifiers.adjust_in:
                if (cur_loop_mod == cst.loop_modifiers.adjust_in && timer_present) {
                    return;
                }
                stop_blink();
                PioneerDDJ400.state.timers[channel][timer_id] = engine.beginTimer(cst.times.loop_adjust, function () {
                    blink_state = !blink_state;
                    it.update_light(channel, cst.lights.loop_in, blink_state);
                    it.update_light(channel, cst.lights.shift_loop_in, blink_state);
                });
                it.update_light(channel, cst.lights.loop_out, false);
                it.update_light(channel, cst.lights.shift_loop_out, false);
                PioneerDDJ400.state.channel[channel].current_loop_modifier = cst.loop_modifiers.adjust_in;
                break;
            case cst.loop_modifiers.adjust_out:
                if (cur_loop_mod == cst.loop_modifiers.adjust_out && timer_present) {
                    return;
                }
                stop_blink();
                it.update_light(channel, cst.lights.loop_in, false);
                it.update_light(channel, cst.lights.shift_loop_in, false);
                PioneerDDJ400.state.timers[channel][timer_id] = engine.beginTimer(cst.times.loop_adjust, function () {
                    blink_state = !blink_state;
                    it.update_light(channel, cst.lights.loop_out, blink_state);
                    it.update_light(channel, cst.lights.shift_loop_out, blink_state);
                });
                PioneerDDJ400.state.channel[channel].current_loop_modifier = cst.loop_modifiers.adjust_out;
                break;
        };
    },
    set_loop_enabled: function (value, group) {
        const it = PioneerDDJ400.internal;
        var deck = it.group_to_deck(group);
        it.set_loop_adjust_state(deck, PioneerDDJ400.constants.loop_modifiers.none);

        if (it.is_group_active(group)) {
            var channel = it.group_to_channel(group);
            it.set_reloop_light(channel, value);
        }
    },
    set_loop_adjust_state: function (deck, state) {
        const it = PioneerDDJ400.internal;
        PioneerDDJ400.state.deck[deck].loop_adjust = state;
        if (it.is_deck_active(deck)) {
            it.update_loop_inout_lights(it.deck_to_channel(deck));
        }
    },
    get_loop_adjust_state: function (deck) {
        if (PioneerDDJ400.state.deck[deck].loop_adjust !== undefined) {
            return PioneerDDJ400.state.deck[deck].loop_adjust;
        }
        return PioneerDDJ400.constants.loop_modifiers.none;
    },
    update_beatloop: function (value, group, padnum) {
        const it = PioneerDDJ400.internal;
        if (!it.is_group_active(group)) {
            return;
        }

        var channel = it.group_to_channel(group);
        it.set_pad_light(PioneerDDJ400.constants.pad_modes.beat_loop, channel, padnum, false, value ? 0x7F : 0x00);
    },
    update_beatloop_025: function (value, group) {
        PioneerDDJ400.internal.update_beatloop(value, group, 0);
    },
    update_beatloop_05: function (value, group) {
        PioneerDDJ400.internal.update_beatloop(value, group, 1);
    },
    update_beatloop_1: function (value, group) {
        PioneerDDJ400.internal.update_beatloop(value, group, 2);
    },
    update_beatloop_2: function (value, group) {
        PioneerDDJ400.internal.update_beatloop(value, group, 3);
    },
    update_beatloop_4: function (value, group) {
        PioneerDDJ400.internal.update_beatloop(value, group, 4);
    },
    update_beatloop_8: function (value, group) {
        PioneerDDJ400.internal.update_beatloop(value, group, 5);
    },
    update_beatloop_16: function (value, group) {
        PioneerDDJ400.internal.update_beatloop(value, group, 6);
    },
    update_beatloop_32: function (value, group) {
        PioneerDDJ400.internal.update_beatloop(value, group, 7);
    },
    // setup
    update_deck_channel_indicator: function (channel) {
        const it = PioneerDDJ400.internal;
        const cst = PioneerDDJ400.constants;
        const deck = it.channel_to_deck(channel);
        const is_primary = (deck == cst.primary_deck[channel]) ? 0x7f : 0x00;
        it.set_pad_light(cst.pad_modes.beat_jump, channel, 0, true, is_primary);
    },
    disconnect_channel: function (channel) {
        // clear timers
        for (var timer in PioneerDDJ400.state.timers[channel]) {
            if (PioneerDDJ400.state.timers[channel][timer] !== undefined) {
                engine.stopTimer(PioneerDDJ400.state.timers[channel][timer]);
            }
        }
        PioneerDDJ400.state.timers[channel] = {};

        // disconnect
        for (var conn in PioneerDDJ400.state.connections[channel]) {
            if (PioneerDDJ400.state.connections[channel][conn] != undefined) {
                PioneerDDJ400.state.connections[channel][conn].disconnect();
            }
        }
        PioneerDDJ400.state.connections[channel] = {};

        // prepare soft takeover
        const group = PioneerDDJ400.internal.channel_to_group(channel);
        const eq_group = '[EqualizerRack1_' + group + '_Effect1]';
        engine.softTakeoverIgnoreNextValue(eq_group, 'parameter1');
        engine.softTakeoverIgnoreNextValue(eq_group, 'parameter2');
        engine.softTakeoverIgnoreNextValue(eq_group, 'parameter3');
        engine.softTakeoverIgnoreNextValue('[QuickEffectRack1_' + group + ']', 'super1');
        engine.softTakeoverIgnoreNextValue(group, 'pregain');
        engine.softTakeoverIgnoreNextValue(group, 'volume');
    },
    connect_channel: function (channel) {
        const it = PioneerDDJ400.internal;
        var deck = it.channel_to_deck(channel);
        var group = it.deck_to_group(deck);
        print('Connecting: channel: ' + channel + ', deck: ' + deck + ', group: ' + group);

        // connect
        const c2f = PioneerDDJ400.constants.output_control_to_function;
        for (var control in c2f) {
            PioneerDDJ400.state.connections[channel][control] = engine.makeConnection(group, control, c2f[control].fun);
            if (c2f[control].trig) {
                PioneerDDJ400.state.connections[channel][control].trigger();
            }
        }

        // restore extra timers, lights that are not done upon connection trigger
        it.connect_samplers(channel);
        it.update_deck_channel_indicator(channel);
        it.update_fx_light();
    },
    toggle_deck_channel_gateway: function (channel) {
        if (PioneerDDJ400.constants.always_toggle_both) {
            PioneerDDJ400.internal.toggle_deck_channel(0);
            PioneerDDJ400.internal.toggle_deck_channel(1);
            return;
        }
        PioneerDDJ400.internal.toggle_deck_channel(channel);
    },
    toggle_deck_channel: function (channel) {
        const old_deck = PioneerDDJ400.internal.channel_to_deck(channel);
        const next_deck = PioneerDDJ400.internal.next_deck(channel, old_deck);
        if (old_deck == next_deck) {
            print('Would toggle deck but next deck is identical (turn on 4 deck mode).');
            return;
        }

        print('Toggling deck from ' + old_deck + ' to ' + next_deck + '.');

        // disconnect channel
        PioneerDDJ400.internal.disconnect_channel(channel);

        // set active deck
        PioneerDDJ400.state.channel_mapping[channel] = next_deck;

        // connect channel pair
        PioneerDDJ400.internal.connect_channel(channel);
    },
    // shift
    shift_double_press: function (channel) {
        PioneerDDJ400.internal.toggle_deck_channel_gateway(channel);
    },
    get_shift_double: function (channel) {
        if (PioneerDDJ400.state.channel[channel].shift_double !== undefined) {
            return PioneerDDJ400.state.channel[channel].shift_double;
        }
        return false;
    },
    set_shift_double: function (channel, value) {
        PioneerDDJ400.state.channel[channel].shift_double = value;
    },
    set_shift_button_pressed: function (channel, pressed) {
        PioneerDDJ400.state.channel[channel].shift_button_pressed = pressed;
        const last_ch = PioneerDDJ400.state.last_shift_button_pressed;
        PioneerDDJ400.state.last_shift_button_pressed = channel;

        if (last_ch != channel) {
            this.update_fx_light();
        }

        // From first press to second release must be < configured time to count as double press.
        const new_pressed = Date.now();
        const within_time = (new_pressed - this.get_last_shift_time(channel)) < PioneerDDJ400.constants.times.double_press;
        if (pressed) {
            this.set_shift_double(channel, within_time);
            if (!within_time) {
                PioneerDDJ400.state.channel[channel].shift_time = new_pressed;
            }
        } else {
            if (within_time && this.get_shift_double(channel)) {
                this.shift_double_press(channel);
            }
        }
    },
    get_shift_button_pressed: function (channel) {
        if (PioneerDDJ400.state.channel[channel].shift_button_pressed !== undefined) {
            return PioneerDDJ400.state.channel[channel].shift_button_pressed;
        }
        return false;
    },
    get_last_shift_time: function (channel) {
        if (PioneerDDJ400.state.channel[channel].shift_time !== undefined) {
            return PioneerDDJ400.state.channel[channel].shift_time;
        }
        return 0;
    },
    get_any_shift_button_pressed: function () {
        return PioneerDDJ400.internal.get_shift_button_pressed(0) || PioneerDDJ400.internal.get_shift_button_pressed(1);
    },
    get_last_shift_channel: function () {
        return PioneerDDJ400.state.last_shift_button_pressed;
    },
    // effects
    get_deck_effect_unit: function (deck) {
        return PioneerDDJ400.state.deck[deck].effect_unit;
    },
    get_effect_unit_group: function (unit) {
        return '[EffectRack1_EffectUnit' + unit + ']';
    },
    get_deck_effect_unit_group: function (deck) {
        const it = PioneerDDJ400.internal;
        var unit = it.get_deck_effect_unit(deck);
        return it.get_effect_unit_group(unit);
    },
    get_focussed_effect: function (deck) {
        return engine.getValue(PioneerDDJ400.internal.get_deck_effect_unit_group(deck), "focused_effect");
    },
    get_effect_group: function (unit, slot) {
        return '[EffectRack1_EffectUnit' + unit + '_Effect' + slot + ']';
    },
    get_focussed_effect_group: function (deck) {
        const it = PioneerDDJ400.internal;
        var unit = it.get_deck_effect_unit(deck);
        var focussed = it.get_focussed_effect(deck);
        return it.get_effect_group(unit, focussed);
    },
    get_effect_deck: function () {
        const it = PioneerDDJ400.internal;
        return it.channel_to_deck(it.get_last_shift_channel());
    },
    get_num_effect_slots: function (unit) {
        return engine.getValue(PioneerDDJ400.internal.get_effect_unit_group(unit), 'num_effectslots');
    },
    update_fx_light: function () {
        const it = PioneerDDJ400.internal;
        const deck = it.get_effect_deck();
        const enabled = engine.getValue(it.get_focussed_effect_group(deck), 'enabled');
        it.update_light(0, PioneerDDJ400.constants.lights.beat_fx, enabled);
    },
    // mixer
    log_10: function (x) {
        return Math.log(x) / Math.log(10);
    },
    ratio_to_db: function (ratio) {
        return PioneerDDJ400.internal.log_10(ratio) * 20.0;
    },
    db_to_ratio: function (db) {
        return Math.pow(10.0, db / 20.0);
    },
    parameter_to_value: function (param, min_db, max_db, neutral_param) {
        // This one is better than script.absoluteNonLin because it does what Mixxx would do
        // internally if the value was sent directly.
        const it = PioneerDDJ400.internal;
        var value = 1;
        var offset = it.db_to_ratio(min_db);
        if (param <= 0.0) {
            value = 0;
        } else if (param < neutral_param) {
            var db = (param * min_db / (neutral_param * -1)) + min_db;
            value = (it.db_to_ratio(db) - offset) / (1 - offset);
        } else if (param == neutral_param) {
            value = 1.0;
        } else if (param < 1.0) {
            value = it.db_to_ratio((param - neutral_param) * max_db / (1 - neutral_param));
        } else {
            value = it.db_to_ratio(max_db);
        }
        return value;
    },
    parameter_to_value_eq: function (param) {
        return PioneerDDJ400.internal.parameter_to_value(param, -12, PioneerDDJ400.internal.ratio_to_db(4.0), 0.5);
    },
    parameter_to_value_volume: function (param) {
        return PioneerDDJ400.internal.parameter_to_value(param, -20, 0, 1);
    },
    set_low: function (group, param) {
        engine.setValue('[EqualizerRack1_' + group + '_Effect1]', 'parameter1', PioneerDDJ400.internal.parameter_to_value_eq(param));
    },
    set_mid: function (group, param) {
        engine.setValue('[EqualizerRack1_' + group + '_Effect1]', 'parameter2', PioneerDDJ400.internal.parameter_to_value_eq(param));
    },
    set_hi: function (group, param) {
        engine.setValue('[EqualizerRack1_' + group + '_Effect1]', 'parameter3', PioneerDDJ400.internal.parameter_to_value_eq(param));
    },
    // filter
    set_quick_effect_super1: function (group, value) {
        engine.setValue('[QuickEffectRack1_' + group + ']', 'super1', value);
    },
    // pads
    set_pad_light: function (mode, channel, padnum, shift, value) {
        var midi_out = {
            status: 0x97 + 2 * (channel ? 1 : 0) + (shift ? 1 : 0),
            data1: mode + padnum,
        };

        midi.sendShortMsg(midi_out.status, midi_out.data1, value);
    },
    allow_beatjump_downscale: function (channel) {
        return !(PioneerDDJ400.state.channel[channel].beatjump_scalestep <= -1);
    },
    allow_beatjump_upscale: function (channel) {
        return !(PioneerDDJ400.state.channel[channel].beatjump_scalestep >= 1);
    },
    update_beatjump_shift_lights: function (channel) {
        const it = PioneerDDJ400.internal;
        const cst = PioneerDDJ400.constants;

        it.set_pad_light(cst.pad_modes.beat_jump, channel, 6, true,
            it.allow_beatjump_downscale(channel) ? 0x7F : 0x00);

        it.set_pad_light(cst.pad_modes.beat_jump, channel, 7, true,
            it.allow_beatjump_upscale(channel) ? 0x7F : 0x00);
    },
    // hotcue
    update_hotcue: function (value, group, padnum) {
        const it = PioneerDDJ400.internal;
        if (!it.is_group_active(group)) {
            return;
        }

        var channel = it.group_to_channel(group);
        it.set_pad_light(PioneerDDJ400.constants.pad_modes.hot_cue, channel, padnum, false, value ? 0x7F : 0x00);
        it.set_pad_light(PioneerDDJ400.constants.pad_modes.hot_cue, channel, padnum, true, value ? 0x7F : 0x00);
    },
    update_hotcue_1: function (value, group) {
        PioneerDDJ400.internal.update_hotcue(value, group, 0);
    },
    update_hotcue_2: function (value, group) {
        PioneerDDJ400.internal.update_hotcue(value, group, 1);
    },
    update_hotcue_3: function (value, group) {
        PioneerDDJ400.internal.update_hotcue(value, group, 2);
    },
    update_hotcue_4: function (value, group) {
        PioneerDDJ400.internal.update_hotcue(value, group, 3);
    },
    update_hotcue_5: function (value, group) {
        PioneerDDJ400.internal.update_hotcue(value, group, 4);
    },
    update_hotcue_6: function (value, group) {
        PioneerDDJ400.internal.update_hotcue(value, group, 5);
    },
    update_hotcue_7: function (value, group) {
        PioneerDDJ400.internal.update_hotcue(value, group, 6);
    },
    update_hotcue_8: function (value, group) {
        PioneerDDJ400.internal.update_hotcue(value, group, 7);
    },
    // sampler
    update_sampler: function (value, sampler_group) {
        const it = PioneerDDJ400.internal;

        // The same sampler might be on multiple pads/channels...
        var num_decks = it.get_num_decks();
        for (var deck = 0; deck < num_decks; deck++) {
            if (!it.is_deck_active(deck)) {
                continue;
            }

            var channel = it.deck_to_channel(deck);
            var deck_samplers = PioneerDDJ400.constants.sampler_groups[deck];
            for (var padnum = 0; padnum < deck_samplers.length; padnum++) {
                if (sampler_group == deck_samplers[padnum]) {
                    it.set_pad_light(PioneerDDJ400.constants.pad_modes.sampler, channel, padnum, false, value ? 0x7F : 0x00);
                    it.set_pad_light(PioneerDDJ400.constants.pad_modes.sampler, channel, padnum, true, value ? 0x7F : 0x00);
                }
            }
        }
    },
    connect_samplers: function (channel) {
        const it = PioneerDDJ400.internal;
        var deck = it.channel_to_deck(channel);
        var deck_samplers = PioneerDDJ400.constants.sampler_groups[deck];
        for (var padnum = 0; padnum < deck_samplers.length; padnum++) {
            const control_name = deck_samplers[padnum];
            const control_key = control_name + '_light';
            PioneerDDJ400.state.connections[channel][control_key] = engine.makeConnection(control_name, 'track_loaded', PioneerDDJ400.internal.update_sampler);
            PioneerDDJ400.state.connections[channel][control_key].trigger();
        }
    },
    // brake
    update_brake_light: function () {
        const it = PioneerDDJ400.internal;
        const cst = PioneerDDJ400.constants;
        it.set_pad_light(cst.pad_modes.fx_1, 0, 0, false, 0x7f);
        it.set_pad_light(cst.pad_modes.fx_1, 1, 0, false, 0x7f);
    },
    // headphone cue split
    update_head_split_light: function (value) {
        const it = PioneerDDJ400.internal;
        const cst = PioneerDDJ400.constants;
        it.set_pad_light(cst.pad_modes.beat_jump, 0, 1, true, value ? 0x7f : 0x00);
        it.set_pad_light(cst.pad_modes.beat_jump, 1, 1, true, value ? 0x7f : 0x00);
    }
}

PioneerDDJ400.constants.output_control_to_function = {
    'play_indicator': { fun: PioneerDDJ400.internal.play_indicator, trig: true },
    'cue_indicator': { fun: PioneerDDJ400.internal.cue_indicator, trig: true },
    'VuMeter': { fun: PioneerDDJ400.internal.vu_meter_update, trig: true },
    'track_loaded': { fun: PioneerDDJ400.internal.track_loaded_animation, trig: false },
    'sync_enabled': { fun: PioneerDDJ400.internal.beatsync_update, trig: true },
    'sync_master': { fun: PioneerDDJ400.internal.beatmaster_update, trig: true },
    'pfl': { fun: PioneerDDJ400.internal.headphone_cue_update, trig: true },
    'quantize': { fun: PioneerDDJ400.internal.quantize_update, trig: true },
    'keylock': { fun: PioneerDDJ400.internal.keylock_update, trig: true },
    'loop_enabled': { fun: PioneerDDJ400.internal.set_loop_enabled, trig: true },
    'beatloop_0.25_enabled': { fun: PioneerDDJ400.internal.update_beatloop_025, trig: true },
    'beatloop_0.5_enabled': { fun: PioneerDDJ400.internal.update_beatloop_05, trig: true },
    'beatloop_1_enabled': { fun: PioneerDDJ400.internal.update_beatloop_1, trig: true },
    'beatloop_2_enabled': { fun: PioneerDDJ400.internal.update_beatloop_2, trig: true },
    'beatloop_4_enabled': { fun: PioneerDDJ400.internal.update_beatloop_4, trig: true },
    'beatloop_8_enabled': { fun: PioneerDDJ400.internal.update_beatloop_8, trig: true },
    'beatloop_16_enabled': { fun: PioneerDDJ400.internal.update_beatloop_16, trig: true },
    'beatloop_32_enabled': { fun: PioneerDDJ400.internal.update_beatloop_32, trig: true },
    'hotcue_1_enabled': { fun: PioneerDDJ400.internal.update_hotcue_1, trig: true },
    'hotcue_2_enabled': { fun: PioneerDDJ400.internal.update_hotcue_2, trig: true },
    'hotcue_3_enabled': { fun: PioneerDDJ400.internal.update_hotcue_3, trig: true },
    'hotcue_4_enabled': { fun: PioneerDDJ400.internal.update_hotcue_4, trig: true },
    'hotcue_5_enabled': { fun: PioneerDDJ400.internal.update_hotcue_5, trig: true },
    'hotcue_6_enabled': { fun: PioneerDDJ400.internal.update_hotcue_6, trig: true },
    'hotcue_7_enabled': { fun: PioneerDDJ400.internal.update_hotcue_7, trig: true },
    'hotcue_8_enabled': { fun: PioneerDDJ400.internal.update_hotcue_8, trig: true },
};

// ---- public ----

// jog wheels
PioneerDDJ400.jogTurn = function (channel, _control, value, _status, _group) {
    const it = PioneerDDJ400.internal;
    const cst = PioneerDDJ400.constants;
    const deck = it.channel_to_deck(channel);
    const group = it.deck_to_group(deck);

    // wheel center at 64; <64 rew >64 fwd
    var new_value = (value - 64);

    // loop_in / out adjust
    const loop_enabled = it.get_loop_active(group);
    if (loop_enabled > 0) {
        const loop_modifier = PioneerDDJ400.internal.get_loop_adjust_state(deck);
        var adjust_value = new_value * cst.loop_adjust_multiply;
        if (loop_modifier == cst.loop_modifiers.adjust_in) {
            adjust_value = adjust_value + engine.getValue(group, "loop_start_position");
            engine.setValue(group, "loop_start_position", adjust_value);
            return;
        } else if (loop_modifier == cst.loop_modifiers.adjust_out) {
            adjust_value = adjust_value + engine.getValue(group, "loop_end_position");
            engine.setValue(group, "loop_end_position", adjust_value);
            return;
        }
    }

    var group_number = deck + 1;
    if (engine.isScratching(group_number)) {
        engine.scratchTick(group_number, new_value);
    } else {
        engine.setValue(group, "jog", new_value * cst.bend_scale);
    }
};

PioneerDDJ400.jogSearch = function (channel, _control, value, _status, _group) {
    const it = PioneerDDJ400.internal;
    var new_value = (value - 64) * PioneerDDJ400.constants.fast_seek_scale;
    engine.setValue(it.channel_to_group(channel), "jog", new_value);
};

PioneerDDJ400.jogTouch = function (channel, _control, value) {
    const it = PioneerDDJ400.internal;
    const cst = PioneerDDJ400.constants;
    const deck = it.channel_to_deck(channel);

    // skip while adjusting the loop points
    if (it.get_loop_adjust_state(deck) != cst.loop_modifiers.none) {
        return;
    }

    const group_number = deck + 1;
    if (value !== 0 && cst.vinyl_mode) {
        engine.scratchEnable(group_number, 720, 33 + 1 / 3, cst.jog_alpha, cst.jog_beta);
    } else {
        engine.scratchDisable(group_number);
    }
};

// shift
PioneerDDJ400.shiftPressed = function (channel, _control, value, _status, _group) {
    PioneerDDJ400.internal.set_shift_button_pressed(channel, value === 0x7F);
};

// track loading
PioneerDDJ400.LoadSelectedTrack = function (_channel, _control, value, _status, group) {
    if (!value) {
        return;
    }

    const it = PioneerDDJ400.internal;
    const channel = group == 'L' ? 0 : 1;
    engine.setValue(it.channel_to_group(channel), 'LoadSelectedTrack', 1);
}

// play/pause
PioneerDDJ400.play = function (channel, _control, value, _status, _group) {
    if (value) {
        const it = PioneerDDJ400.internal;
        script.toggleControl(it.channel_to_group(channel), 'play');
    }
}

PioneerDDJ400.reverseroll = function (channel, _control, value, _status, _group) {
    const it = PioneerDDJ400.internal;
    engine.setValue(it.channel_to_group(channel), 'reverseroll', value);
}

// cue button
PioneerDDJ400.cue_default = function (channel, _control, value, _status, _group) {
    const it = PioneerDDJ400.internal;
    const group = it.channel_to_group(channel);

    engine.setValue(group, 'cue_default', value);
}

PioneerDDJ400.start_play = function (channel, _control, value, _status, _group) {
    const it = PioneerDDJ400.internal;
    engine.setValue(it.channel_to_group(channel), 'start_play', value);
}

// effects
PioneerDDJ400.beat_fx_level_depth_msb = function (_channel, _control, value) {
    PioneerDDJ400.state.beat_fx_msb = value;
}

PioneerDDJ400.beat_fx_level_depth_lsb = function (_channel, _control, value) {
    var full_value = (PioneerDDJ400.state.beat_fx_msb << 7) + value;
    const it = PioneerDDJ400.internal;
    var deck = it.get_effect_deck();
    if (it.get_any_shift_button_pressed()) {
        engine.softTakeoverIgnoreNextValue(it.get_deck_effect_unit_group(deck), "mix");
        engine.setParameter(it.get_focussed_effect_group(deck), "meta", full_value / 0x4000);
    } else {
        engine.softTakeoverIgnoreNextValue(it.get_focussed_effect_group(deck), "meta");
        engine.setParameter(it.get_deck_effect_unit_group(deck), "mix", full_value / 0x4000);
    }
};

PioneerDDJ400.focussed_switch_effect = function (next) {
    const it = PioneerDDJ400.internal;
    var slot_group = it.get_focussed_effect_group(it.get_effect_deck());
    if (next) {
        engine.setValue(slot_group, 'next_effect', 1);
    } else {
        engine.setValue(slot_group, 'prev_effect', 1);
    }
}

PioneerDDJ400.focussed_next_effect = function (_channel, _control, value, _status, _group) {
    if (value) {
        PioneerDDJ400.focussed_switch_effect(true);
    }
}

PioneerDDJ400.focussed_prev_effect = function (_channel, _control, value, _status, _group) {
    if (value) {
        PioneerDDJ400.focussed_switch_effect(false);
    }
}

PioneerDDJ400.switch_effect_slot = function (next) {
    const it = PioneerDDJ400.internal;
    const deck = it.get_effect_deck();
    const unit = it.get_deck_effect_unit(deck);
    const unit_group = it.get_effect_unit_group(unit)
    const delta = next ? 1 : -1;
    const num_slots = it.get_num_effect_slots(unit);

    var old_focus = it.get_focussed_effect(deck);
    var new_focus = 0;

    if (old_focus) {
        old_focus -= 1;

        new_focus = old_focus + delta;
        if (new_focus < 0) {
            new_focus += num_slots;
        } else {
            new_focus = new_focus % num_slots;
        }
    }

    new_focus += 1;
    engine.setValue(unit_group, 'focused_effect', new_focus);
}

PioneerDDJ400.next_effect_slot = function (_channel, _control, value, _status, _group) {
    if (value) {
        PioneerDDJ400.switch_effect_slot(true);
    }
}

PioneerDDJ400.prev_effect_slot = function (_channel, _control, value, _status, _group) {
    if (value) {
        PioneerDDJ400.switch_effect_slot(false);
    }
}

PioneerDDJ400.beat_fx_onoff = function (_channel, _control, value) {
    if (value === 0) {
        return;
    }

    const it = PioneerDDJ400.internal;
    var slot_group = it.get_focussed_effect_group(it.get_effect_deck());

    var enabled = !engine.getValue(slot_group, "enabled");
    engine.setValue(slot_group, "enabled", enabled);
};

PioneerDDJ400.beat_fx_onoff_shift = function (_channel, _control, value, _status, _group) {
    if (value === 0) {
        return;
    }

    const it = PioneerDDJ400.internal;

    var deck = it.get_effect_deck();
    var unit = it.get_deck_effect_unit(deck);
    var unit_group = it.get_effect_unit_group(unit);
    var num_slots = it.get_num_effect_slots(unit);

    engine.setParameter(unit_group, "mix", 0);
    engine.softTakeoverIgnoreNextValue(unit_group, "mix");

    // disable all in effect unit
    for (var slot = 1; slot <= num_slots; slot++) {
        engine.setValue(it.get_effect_group(unit, slot), "enabled", 0);
    }
}

PioneerDDJ400.beat_fx_channel = function (_channel, control, value, _status, _group) {
    if (value === 0x00) { return; }

    const it = PioneerDDJ400.internal;
    var enable = [];
    var deck = 0;
    var num_decks = it.get_num_decks();
    for (deck = 0; deck <= num_decks; deck++) {
        enable[deck] = 0;
    }

    switch (control) {
        case 0x10:
            enable[it.channel_to_deck(0)] = 1;
            break;
        case 0x11:
            enable[it.channel_to_deck(1)] = 1;
            break;
        case 0x14:
            enable[num_decks] = 1;
            break;
        default:
            break;
    }

    var effect_deck = it.get_effect_deck();
    var effect_unit = it.get_deck_effect_unit(effect_deck);

    for (deck = 0; deck < num_decks; deck++) {
        if (it.get_deck_effect_unit(deck) != effect_unit) {
            enable[deck] = 0;
        }
    }

    for (deck = 0; deck < num_decks; deck++) {
        engine.setValue(it.get_effect_unit_group(effect_unit), 'group_[Channel' + (deck + 1) + ']_enable', enable[deck]);
    }
    engine.setValue(it.get_effect_unit_group(effect_unit), 'group_[Master]_enable', enable[deck]);
}

// loop
PioneerDDJ400.loop_in = function (channel, _control, value, _status, _group) {
    if (!value) {
        return;
    }

    const it = PioneerDDJ400.internal;
    const cst = PioneerDDJ400.constants;

    const deck = it.channel_to_deck(channel);
    const group = it.deck_to_group(deck);

    if (it.get_loop_active(group)) {
        if (it.get_loop_adjust_state(deck) == cst.loop_modifiers.adjust_in) {
            it.set_loop_adjust_state(deck, cst.loop_modifiers.none);
        } else {
            it.set_loop_adjust_state(deck, cst.loop_modifiers.adjust_in);
        }
        return;
    }

    engine.setValue(group, 'loop_end_position', -1);
    engine.setValue(group, 'loop_in', 1);
    engine.setValue(group, 'loop_in', 0);
}

PioneerDDJ400.loop_in_long = function (channel, _control, _value, _status, _group) {
    const it = PioneerDDJ400.internal;
    const group = it.channel_to_group(channel);
    if (it.get_loop_active(group)) {
        return;
    }

    engine.setValue(group, 'beatloop_size', 4);
    engine.setValue(group, 'beatloop_keep_loopin', 4);
}

PioneerDDJ400.loop_out = function (channel, _control, value, _status, _group) {
    if (!value) {
        return;
    }

    const it = PioneerDDJ400.internal;
    const cst = PioneerDDJ400.constants;

    const deck = it.channel_to_deck(channel);
    const group = it.deck_to_group(deck);

    if (it.get_loop_active(group)) {
        if (it.get_loop_adjust_state(deck) == cst.loop_modifiers.adjust_out) {
            it.set_loop_adjust_state(deck, cst.loop_modifiers.none);
        } else {
            it.set_loop_adjust_state(deck, cst.loop_modifiers.adjust_out);
        }
        return;
    }

    engine.setValue(group, 'loop_out', 1);
    engine.setValue(group, 'loop_out', 0);
}

PioneerDDJ400.reloop_toggle = function (channel, _control, value, _status, _group) {
    if (!value) {
        return;
    }

    const it = PioneerDDJ400.internal;
    const group = it.channel_to_group(channel);

    engine.setValue(group, 'reloop_toggle', 1);
}

PioneerDDJ400.reloop_andstop = function (channel, _control, value, _status, _group) {
    if (!value) {
        return;
    }

    const it = PioneerDDJ400.internal;
    const group = it.channel_to_group(channel);

    engine.setValue(group, 'reloop_andstop', 1);
}

PioneerDDJ400.cueLoopCallLeft = function (channel, _control, value, _status, _group) {
    if (!value) {
        return;
    }

    engine.setValue(PioneerDDJ400.internal.channel_to_group(channel), "loop_scale", 0.5);
}

PioneerDDJ400.cueLoopCallRight = function (channel, _control, value, _status, _group) {
    if (!value) {
        return;
    }

    engine.setValue(PioneerDDJ400.internal.channel_to_group(channel), "loop_scale", 2);
}

PioneerDDJ400.quickJumpBack = function (channel, _control, value, _status, _group) {
    if (!value) {
        return;
    }

    engine.setValue(PioneerDDJ400.internal.channel_to_group(channel), 'beatjump', -PioneerDDJ400.constants.quick_jump_size);
}

PioneerDDJ400.quickJumpForward = function (channel, _control, value, _status, _group) {
    if (!value) {
        return;
    }

    engine.setValue(PioneerDDJ400.internal.channel_to_group(channel), 'beatjump', PioneerDDJ400.constants.quick_jump_size);
}

// channel volume

PioneerDDJ400.volumeMSB = function (channel, _control, value, _status, _group) {
    PioneerDDJ400.state.channel[channel].volumeMSB = value;
}

PioneerDDJ400.volumeLSB = function (channel, _control, value, _status, _group) {
    const it = PioneerDDJ400.internal;
    const full_value = (PioneerDDJ400.state.channel[channel].volumeMSB << 7) + value;

    engine.setValue(
        it.channel_to_group(channel),
        'volume',
        it.parameter_to_value_volume(full_value / 0x4000)
    );
}

// headphone cue buttons
PioneerDDJ400.toggleQuantize = function (channel, _control, value, _status, _group) {
    if (!value) {
        return;
    }

    script.toggleControl(PioneerDDJ400.internal.channel_to_group(channel), 'quantize');
}

PioneerDDJ400.headphone_cue = function (channel, _control, value, _status, _group) {
    if (!value) {
        return;
    }

    script.toggleControl(PioneerDDJ400.internal.channel_to_group(channel), 'pfl');
}

// channel mixer
PioneerDDJ400.mix_trim_lsb = function (channel, _control, value, _status, _group) {
    const it = PioneerDDJ400.internal;
    const full_value = (PioneerDDJ400.state.channel[channel].mix_trim_msb << 7) + value;

    engine.setValue(
        it.channel_to_group(channel),
        'pregain',
        it.parameter_to_value_eq(full_value / 0x4000)
    );
}

PioneerDDJ400.mix_trim_msb = function (channel, _control, value, _status, _group) {
    PioneerDDJ400.state.channel[channel].mix_trim_msb = value;
}

PioneerDDJ400.mix_low_lsb = function (channel, _control, value, _status, _group) {
    const full_value = (PioneerDDJ400.state.channel[channel].mix_low_msb << 7) + value;
    const it = PioneerDDJ400.internal;
    it.set_low(it.channel_to_group(channel), full_value / 0x4000);
}

PioneerDDJ400.mix_low_msb = function (channel, _control, value, _status, _group) {
    PioneerDDJ400.state.channel[channel].mix_low_msb = value;
}

PioneerDDJ400.mix_mid_lsb = function (channel, _control, value, _status, _group) {
    const full_value = (PioneerDDJ400.state.channel[channel].mix_mid_msb << 7) + value;
    const it = PioneerDDJ400.internal;
    it.set_mid(it.channel_to_group(channel), full_value / 0x4000);
}

PioneerDDJ400.mix_mid_msb = function (channel, _control, value, _status, _group) {
    PioneerDDJ400.state.channel[channel].mix_mid_msb = value;
}

PioneerDDJ400.mix_hi_lsb = function (channel, _control, value, _status, _group) {
    const full_value = (PioneerDDJ400.state.channel[channel].mix_hi_msb << 7) + value;
    const it = PioneerDDJ400.internal;
    it.set_hi(it.channel_to_group(channel), full_value / 0x4000);
}

PioneerDDJ400.mix_hi_msb = function (channel, _control, value, _status, _group) {
    PioneerDDJ400.state.channel[channel].mix_hi_msb = value;
}

// quick effect
PioneerDDJ400.super1_lsb = function (_channel, _control, value, _status, group) {
    const channel = group === 'L' ? 0 : 1;
    const full_value = (PioneerDDJ400.state.channel[channel].effect_super1_msb << 7) + value;
    const it = PioneerDDJ400.internal;
    it.set_quick_effect_super1(it.channel_to_group(channel), full_value / 0x4000);
}

PioneerDDJ400.super1_msb = function (_channel, _control, value, _status, group) {
    const channel = group === 'L' ? 0 : 1;
    PioneerDDJ400.state.channel[channel].effect_super1_msb = value;
}

// tempo
PioneerDDJ400.tempoSliderMSB = function (channel, _control, value, _status, _group) {
    PioneerDDJ400.state.channel[channel].tempoSliderMSB = value;
};

PioneerDDJ400.tempoSliderLSB = function (channel, _control, value, _status, _group) {
    const full_value = (PioneerDDJ400.state.channel[channel].tempoSliderMSB << 7) + value;

    engine.setValue(
        PioneerDDJ400.internal.channel_to_group(channel),
        'rate',
        1 - (full_value / 0x2000)
    );
}

// beat sync
PioneerDDJ400.syncPressed = function (channel, _control, value, _status, _group) {
    if (!value) {
        return;
    }

    // set as slave
    const group = PioneerDDJ400.internal.channel_to_group(channel);
    if (engine.getValue(group, 'sync_mode')) {
        engine.setValue(group, 'sync_mode', 0);
    } else {
        engine.setValue(group, 'beatsync', 1);
        engine.setValue(group, 'sync_mode', 1);
    }
}

PioneerDDJ400.syncLongPressed = function (channel, _control, value, _status, _group) {
    if (!value) {
        return;
    }

    // set as master
    const group = PioneerDDJ400.internal.channel_to_group(channel);
    if (engine.getValue(group, 'sync_mode')) {
        engine.setValue(group, 'sync_mode', 0);
    } else {
        engine.setValue(group, 'sync_mode', 2);
    }
}

PioneerDDJ400.cycleTempoRange = function (channel, _control, value, _status, _group) {
    if (value === 0) {
        return;
    }

    const group = PioneerDDJ400.internal.channel_to_group(channel);

    const curr_range = engine.getValue(group, "rateRange");
    const tempos = PioneerDDJ400.constants.tempo_range;

    var idx = 0;

    for (var i = 0; i < tempos.length; i++) {
        if (curr_range === tempos[i]) {
            idx = (i + 1) % tempos.length;
            break;
        }
    }
    engine.setValue(group, "rateRange", tempos[idx]);
}

// pads
PioneerDDJ400.handle_hotcue = function (channel, padnum, shift, value) {
    const it = PioneerDDJ400.internal;
    const padidx = padnum + 1;
    if (shift) {
        if (value) {
            engine.setValue(it.channel_to_group(channel), 'hotcue_' + padidx + '_clear', 1);
        }
    } else {
        engine.setValue(it.channel_to_group(channel), 'hotcue_' + padidx + '_activate', value);
    }
}

PioneerDDJ400.handle_beatjump_shift = function (channel, padnum, _shift, _value) {
    const it = PioneerDDJ400.internal;

    // 1st (0) alternative for switching decks (also shows if the primary deck is active)
    if (padnum == 0) {
        it.toggle_deck_channel_gateway(channel);
        return;
    }

    // 2nd (1) toggle headphone cue split
    if (padnum == 1) {
        script.toggleControl('[Master]', 'headSplit');
        return;
    }

    // 4th (3) for toggling keylock
    if (padnum == 3) {
        script.toggleControl(it.channel_to_group(channel), 'keylock');
        return;
    }

    // 7th / 8th (6/7) pad for scaling beatjump
    const allow_upscale = it.allow_beatjump_upscale(channel);
    const allow_downscale = it.allow_beatjump_downscale(channel);

    if (padnum == 6 && allow_downscale) {
        PioneerDDJ400.state.channel[channel].beatjump_scalestep -= 1;
        it.update_beatjump_shift_lights(channel);
        return;
    }

    if (padnum == 7 && allow_upscale) {
        PioneerDDJ400.state.channel[channel].beatjump_scalestep += 1;
        it.update_beatjump_shift_lights(channel);
        return;
    }
}

PioneerDDJ400.handle_beatjump = function (channel, padnum, shift, value) {
    if (!value) {
        return;
    }

    if (shift) {
        PioneerDDJ400.handle_beatjump_shift(channel, padnum, shift, value);
        return;
    }

    const it = PioneerDDJ400.internal;
    const group = it.channel_to_group(channel);
    const beatjump_fac = Math.pow(PioneerDDJ400.constants.beatjump_scalefac, PioneerDDJ400.state.channel[channel].beatjump_scalestep);
    const jump = beatjump_fac * PioneerDDJ400.constants.beatjump_sizes[padnum];
    engine.setValue(group, 'beatjump', jump);
}

PioneerDDJ400.handle_beatloop = function (channel, padnum, shift, value) {
    if (!value || shift) {
        return;
    }

    const it = PioneerDDJ400.internal;
    const size = PioneerDDJ400.constants.beatloop_sizes[padnum];
    const control_name = 'beatloop_' + size + '_toggle';
    engine.setValue(it.channel_to_group(channel), control_name, 1);
}

PioneerDDJ400.handle_sampler = function (channel, padnum, shift, value) {
    const it = PioneerDDJ400.internal;
    const deck = it.channel_to_deck(channel);
    const sampler_group = PioneerDDJ400.constants.sampler_groups[deck][padnum];
    if (shift) {
        if (engine.getValue(sampler_group, 'play')) {
            engine.setValue(sampler_group, 'cue_gotoandstop', value);
        } else if (engine.getValue(sampler_group, 'track_loaded')) {
            engine.setValue(sampler_group, 'eject', value);
        }
    } else {
        if (engine.getValue(sampler_group, 'track_loaded')) {
            engine.setValue(sampler_group, 'cue_gotoandplay', value);
        } else {
            engine.setValue(sampler_group, 'LoadSelectedTrack', value);
        }
    }
}

PioneerDDJ400.handle_fx1 = function (channel, padnum, shift, value) {
    if (shift) {
        return;
    }

    const it = PioneerDDJ400.internal;

    if (padnum == 0) {
        const mixxx_deck_idx = it.channel_to_deck(channel) + 1;
        engine.brake(mixxx_deck_idx, value, PioneerDDJ400.constants.brake_speed);
        return;
    }
}

PioneerDDJ400.handle_pad = function (padchannel, control, value, status, _group) {
    const it = PioneerDDJ400.internal;
    const channel = it.padchannel_to_channel(padchannel);
    const shift = it.padchannel_has_shift(padchannel);
    const padnum = control & 0x0f;
    const mode = control & 0xf0;
    const pad_modes = PioneerDDJ400.constants.pad_modes;

    switch (mode) {
        case pad_modes.hot_cue:
            PioneerDDJ400.handle_hotcue(channel, padnum, shift, value);
            break;
        case pad_modes.beat_loop:
            PioneerDDJ400.handle_beatloop(channel, padnum, shift, value);
            break;
        case pad_modes.beat_jump:
            PioneerDDJ400.handle_beatjump(channel, padnum, shift, value);
            break;
        case pad_modes.sampler:
            PioneerDDJ400.handle_sampler(channel, padnum, shift, value);
            break;
        case pad_modes.keyboard:
            break;
        case pad_modes.fx_1:
            PioneerDDJ400.handle_fx1(channel, padnum, shift, value);
            break;
        case pad_modes.fx_2:
            break;
        case pad_modes.key_shift:
            break;
        default:
            break;
    }
}



// init, shutdown
PioneerDDJ400.init = function (_id, _debugging) {
    const it = PioneerDDJ400.internal;
    const cst = PioneerDDJ400.constants;

    // play track loaded animation for fun
    it.track_loaded_animation(1, 0);
    it.track_loaded_animation(1, 1);

    var num_decks = it.get_num_decks();

    // set default effect units
    for (var deck = 0; deck < num_decks; deck++) {
        PioneerDDJ400.state.deck[deck].effect_unit = cst.default_effect_unit[deck];
    }

    // set initial beatjump scale
    PioneerDDJ400.state.channel[0].beatjump_scalestep = 0;
    PioneerDDJ400.state.channel[1].beatjump_scalestep = 0;

    // set beatjump scale lights
    it.update_beatjump_shift_lights(0);
    it.update_beatjump_shift_lights(1);

    // set backspin length
    it.set_backspin_length(cst.backspin_length);

    // set brake light
    it.update_brake_light();

    // init head cue split
    it.update_head_split_light(engine.getValue('[Master]', 'headSplit'));
    PioneerDDJ400.state.persistent_connections['head_split'] = engine.makeConnection('[Master]', 'headSplit', it.update_head_split_light);

    // init current loop modifier state
    PioneerDDJ400.state.channel[0].current_loop_modifier = cst.loop_modifiers.none;
    PioneerDDJ400.state.channel[1].current_loop_modifier = cst.loop_modifiers.none;

    // configure soft takeovers
    // effects (effects stay connected, see 'Oddities')
    const num_effect_units = engine.getValue('[EffectRack1]', 'num_effectunits');
    for (var unit = 1; unit <= num_effect_units; unit++) {
        var unit_group = it.get_effect_unit_group(unit);
        engine.softTakeover(unit_group, 'mix', true);
        engine.setValue(unit_group, 'show_focus', 1);
        PioneerDDJ400.state.persistent_connections['effect_unit_' + unit + '_focussed'] = engine.makeConnection(unit_group, 'focused_effect', it.update_fx_light);

        const num_effect_slots = it.get_num_effect_slots(unit);
        for (var slot = 1; slot <= num_effect_slots; slot++) {
            var effect_group = it.get_effect_group(unit, slot);
            engine.softTakeover(effect_group, 'meta', true);
            PioneerDDJ400.state.persistent_connections['effect_unit_' + unit + '_slot_' + slot + '_enabled'] = engine.makeConnection(effect_group, 'enabled', it.update_fx_light);
        }
    }

    // equalizer, quick effect, trim
    for (var deck = 0; deck < 4; deck++) {
        const group = it.deck_to_group(deck);
        const eq_group = '[EqualizerRack1_' + group + '_Effect1]';
        print('Setting up soft takeover for: ' + eq_group);
        engine.softTakeover(eq_group, 'parameter1', true);
        engine.softTakeover(eq_group, 'parameter2', true);
        engine.softTakeover(eq_group, 'parameter3', true);
        engine.softTakeover('[QuickEffectRack1_' + group + ']', 'super1', true);
        engine.softTakeover(group, 'pregain', true);
        engine.softTakeover(group, 'volume', true);
    }


    // connect initial channel <-> deck
    it.connect_channel(0);
    it.connect_channel(1);
}

PioneerDDJ400.shutdown = function () {
    for (var conn in PioneerDDJ400.state.persistent_connections) {
        if (PioneerDDJ400.state.persistent_connections[conn] !== undefined) {
            PioneerDDJ400.state.persistent_connections[conn].disconnect();
        }
    }
    PioneerDDJ400.state.persistent_connections = {};

    PioneerDDJ400.internal.disconnect_channel(0);
    PioneerDDJ400.internal.disconnect_channel(1);
}
