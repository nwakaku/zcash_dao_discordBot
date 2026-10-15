const { ActivityType } = require('discord.js');

module.exports = {
    name: 'clientReady',
    once: true,
    execute(client) {
        const tag = client.user.tag;
        const boxTitle = `BOT READY`;
        const boxMessage = `Logged in as ${tag}`;
        const maxLength = Math.max(boxTitle.length, boxMessage.length) + 4;
        console.log(`╔${'─'.repeat(maxLength)}╗`);
        console.log(`║ ${boxTitle.padEnd(maxLength - 2)} ║`);
        console.log(`╠${'─'.repeat(maxLength)}╣`);
        console.log(`║ ${boxMessage.padEnd(maxLength - 2)} ║`);
        console.log(`╚${'─'.repeat(maxLength)}╝`);

        require('../../voteDesk/monitor').startVoteDesk(client);

        (async () => {
            const guildIds = [...client.guilds.cache.keys()];
            let registered = 0;
            for (const guildId of guildIds) {
                if (await client.registerGuildCommands(guildId)) registered += 1;
            }
            console.log(`[COMMANDS] Registered guild commands in ${registered}/${guildIds.length} guild(s).`);
        })().catch(error => console.error('[COMMANDS] Guild registration failed:', error));

        client.user.setPresence({
            status: 'online',
            activities: [{
                name: 'Make sure to leave a star ⭐ on the repo',
                type: ActivityType.Custom,
            }],
        });
    },
};
