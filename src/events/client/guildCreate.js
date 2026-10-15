module.exports = {
    name: 'guildCreate',
    once: false,
    execute(client, guild) {
        if (typeof client.registerGuildCommands !== 'function' || !guild?.id) return;
        client.registerGuildCommands(guild.id)
            .then(ok => console.log(`[COMMANDS] Registered guild commands in new guild ${guild.id}: ${ok}`))
            .catch(error => console.error(`[COMMANDS] Failed to register in guild ${guild.id}:`, error));
    },
};
