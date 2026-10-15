// src/slashCommands/VoteDesk/trigger.js
const {
    SlashCommandBuilder,
    PermissionsBitField,
    TextDisplayBuilder,
    ContainerBuilder,
    SeparatorBuilder,
    MessageFlags,
} = require('discord.js');
const config = require('../../config/config.json');
const { getConfig, getRuntime, runManualPost, TARGETS_PATH } = require('../../voteDesk/monitor');
const { TargetStore } = require('../../voteDesk/targetStore');

const COOLDOWN_MS = 30_000;
const cooldowns = new Map();

function buildContainer(content) {
    return new ContainerBuilder()
        .setAccentColor(parseInt(config.color.replace('#', ''), 16))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(content))
        .addSeparatorComponents(new SeparatorBuilder());
}

function replyEphemeral(interaction, content) {
    return interaction.reply({
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        components: [buildContainer(content)],
    });
}

function isAdmin(interaction) {
    return interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) === true;
}

async function runChannelCommand(interaction) {
    if (!isAdmin(interaction)) {
        return replyEphemeral(interaction, '⚠ Only members with **Manage Server** can change the Vote Desk channel.');
    }

    const targets = await new TargetStore(TARGETS_PATH).load();
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (subcommand === 'set') {
        const channel = interaction.options.getChannel('channel');
        if (!channel?.isTextBased() || typeof channel.send !== 'function') {
            return replyEphemeral(interaction, '⚠ Pick a text channel for scheduled Vote Desk alerts.');
        }
        const perms = channel.permissionsFor?.(interaction.guild.members.me);
        if (perms) {
            const required = [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AttachFiles];
            const missing = required.filter(flag => !perms.has(flag));
            if (missing.length) {
                return replyEphemeral(
                    interaction,
                    `⚠ I need **Send Messages** and **Attach Files** in ${channel} to post scheduled alerts there.`
                );
            }
        }
        await targets.set(guildId, channel.id);
        return replyEphemeral(
            interaction,
            `✅ Scheduled Vote Desk alerts for this server will post in ${channel}.`
        );
    }

    if (subcommand === 'clear') {
        await targets.clear(guildId);
        return replyEphemeral(interaction, '✅ Scheduled Vote Desk alerts are now disabled for this server.');
    }

    const channelId = targets.get(guildId);
    return replyEphemeral(
        interaction,
        channelId
            ? `📌 Scheduled Vote Desk alerts post in <#${channelId}>.`
            : 'No scheduled Vote Desk channel is set for this server. An admin can use `/proposals channel set`.'
    );
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('proposals')
        .setDescription('Vote Desk governance alerts on demand')
        .addSubcommand(subcommand => subcommand
            .setName('post')
            .setDescription('Post the current Vote Desk alert for open proposals right now')
            .addStringOption(option => option
                .setName('proposal')
                .setDescription('Only this proposal, e.g. A185 or 185 (default: all open proposals)')
                .setRequired(false))
            .addChannelOption(option => option
                .setName('channel')
                .setDescription('Channel to post in (default: this channel)')
                .setRequired(false)))
        .addSubcommandGroup(group => group
            .setName('channel')
            .setDescription('Manage the scheduled Vote Desk channel for this server')
            .addSubcommand(subcommand => subcommand
                .setName('set')
                .setDescription('Set the channel for scheduled 48h/24h alerts (admins only)')
                .addChannelOption(option => option
                    .setName('channel')
                    .setDescription('The text channel to receive scheduled alerts')
                    .setRequired(true)))
            .addSubcommand(subcommand => subcommand
                .setName('clear')
                .setDescription('Disable scheduled alerts for this server (admins only)'))
            .addSubcommand(subcommand => subcommand
                .setName('show')
                .setDescription('Show the current scheduled alert channel'))),

    /**
     * @param {import('discord.js').Client} client
     * @param {import('discord.js').CommandInteraction} interaction
     */
    run: async (client, interaction) => {
        const group = interaction.options.getSubcommandGroup(false);

        if (group === 'channel') {
            return runChannelCommand(interaction);
        }

        if (interaction.options.getSubcommand() !== 'post') return;

        const proposal = interaction.options.getString('proposal')?.trim() || undefined;
        const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

        if (!targetChannel?.isTextBased() || typeof targetChannel.send !== 'function') {
            return replyEphemeral(interaction, '⚠ I need a text channel to post the Vote Desk alert in.');
        }

        const botPermissions = targetChannel.permissionsFor?.(interaction.guild.members.me);
        if (botPermissions && !botPermissions.has(PermissionsBitField.Flags.SendMessages)) {
            return replyEphemeral(interaction, `⚠ I need the **Send Messages** permission in ${targetChannel}.`);
        }

        let voteDeskConfig;
        try {
            voteDeskConfig = getConfig();
        } catch (error) {
            return replyEphemeral(interaction, '⚠ Vote Desk configuration is invalid; check the bot logs.');
        }

        if (!voteDeskConfig.daoAddress || !voteDeskConfig.lcdUrl || !voteDeskConfig.daoUrl) {
            return replyEphemeral(interaction, '⚠ Vote Desk is missing a DAO address, LCD URL, or DAO URL.');
        }

        const now = Date.now();
        const remaining = COOLDOWN_MS - (now - (cooldowns.get(interaction.user.id) || 0));
        if (remaining > 0) {
            return replyEphemeral(interaction, `⏳ Please wait ${Math.ceil(remaining / 1000)}s before triggering another Vote Desk post.`);
        }
        cooldowns.set(interaction.user.id, now);

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const { chain } = getRuntime(voteDeskConfig);
            const result = await runManualPost(targetChannel, voteDeskConfig, chain, { proposal });

            let message;
            if (result.posted > 0) {
                message = `✅ Posted Vote Desk for ${result.proposals.join(', ')} in ${targetChannel}.`;
            } else if (result.openCount === 0) {
                message = 'No open proposals to report right now.';
            } else {
                message = `No open proposal matched \`${proposal}\`.`;
            }

            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: [buildContainer(message)],
            });
        } catch (error) {
            console.error('[VOTE DESK] Manual post failed:', error);
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: [buildContainer(`⚠ Failed to post Vote Desk: ${error.message}`)],
            });
        }
    },
};
