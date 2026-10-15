const fs = require('node:fs/promises');
const path = require('node:path');

class TargetStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = {};
    }

    async load() {
        try {
            const contents = await fs.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(contents);
            this.data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            this.data = {};
        }
        return this;
    }

    get(guildId) {
        return this.data[guildId] || null;
    }

    all() {
        return { ...this.data };
    }

    async set(guildId, channelId) {
        this.data[guildId] = channelId;
        await this.save();
    }

    async clear(guildId) {
        if (Object.hasOwn(this.data, guildId)) {
            delete this.data[guildId];
            await this.save();
        }
    }

    async save() {
        const directory = path.dirname(this.filePath);
        await fs.mkdir(directory, { recursive: true });
        const temporaryPath = `${this.filePath}.tmp`;
        await fs.writeFile(temporaryPath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
        await fs.rename(temporaryPath, this.filePath);
    }
}

module.exports = { TargetStore };
