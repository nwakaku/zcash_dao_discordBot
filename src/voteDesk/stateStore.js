const fs = require('node:fs/promises');
const path = require('node:path');

class StateStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = { posts: {}, trackedProposals: {}, baselineProposals: {}, outagePosted: false };
    }

    async load() {
        try {
            const contents = await fs.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(contents);
            this.data = {
                posts: parsed.posts && typeof parsed.posts === 'object' ? parsed.posts : {},
                trackedProposals: parsed.trackedProposals && typeof parsed.trackedProposals === 'object'
                    ? parsed.trackedProposals
                    : {},
                baselineProposals: parsed.baselineProposals && typeof parsed.baselineProposals === 'object'
                    ? parsed.baselineProposals
                    : {},
                outagePosted: Boolean(parsed.outagePosted),
            };
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        return this;
    }

    has(key) {
        return this.data.posts[key] === 'sent';
    }

    unavailableWasPosted(key) {
        return this.data.posts[key] === 'unavailable';
    }

    isTracked(key) {
        return Boolean(this.data.trackedProposals[key]);
    }

    async track(key) {
        if (this.isTracked(key)) return;
        this.data.trackedProposals[key] = true;
        await this.save();
    }

    async mark(key, status) {
        this.data.posts[key] = status;
        await this.save();
    }

    async setOutagePosted(value) {
        this.data.outagePosted = value;
        await this.save();
    }

    async save() {
        const directory = path.dirname(this.filePath);
        await fs.mkdir(directory, { recursive: true });
        const temporaryPath = `${this.filePath}.tmp`;
        await fs.writeFile(temporaryPath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
        await fs.rename(temporaryPath, this.filePath);
    }
}

module.exports = { StateStore };
