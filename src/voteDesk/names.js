const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32ToHex(address) {
    if (!address || typeof address !== 'string') {
        return '';
    }
    const pos = address.lastIndexOf('1');
    if (pos < 1 || pos + 7 > address.length) {
        return '';
    }
    const data = address.slice(pos + 1).split('').map((c) => BECH32_CHARSET.indexOf(c));
    if (data.some((v) => v < 0)) {
        return '';
    }
    const bytes = [];
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < data.length - 6; i += 1) {
        const v = data[i];
        acc = (acc << 5) | v;
        bits += 5;
        while (bits >= 8) {
            bits -= 8;
            bytes.push((acc >> bits) & 0xff);
        }
    }
    return Buffer.from(bytes).toString('hex');
}

class NameResolver {
    constructor(config) {
        this.members = config.members || {};
        this.pfpkApiUrl = (config.pfpkApiUrl || 'https://pfpk.daodao.zone').replace(/\/+$/, '');
        this.cache = new Map();
        this.ttl = 1000 * 60 * 10; // 10 minutes
        this.fetchTimeoutMs = 5000;
    }

    resolve(address) {
        if (!address) {
            return address;
        }
        const member = this.members[address];
        if (member && member.name) {
            return `@${member.name}`;
        }
        return this.resolveFromPfpApi(address);
    }

    async resolveBatch(addresses) {
        const results = new Map();
        for (const address of addresses) {
            const member = this.members[address];
            if (member && member.name) {
                results.set(address, `@${member.name}`);
            } else {
                results.set(address, this.resolveFromPfpApi(address));
            }
        }
        return results;
    }

    resolveFromPfpApi(address) {
        if (this.cache.has(address)) {
            const entry = this.cache.get(address);
            if (Date.now() - entry.time < this.ttl) {
                return entry.value;
            }
            this.cache.delete(address);
        }
        const hex = bech32ToHex(address);
        if (!hex) {
            const short = address.length <= 16 ? address : `${address.slice(0, 8)}...${address.slice(-6)}`;
            this.cache.set(address, { time: Date.now(), value: short });
            return short;
        }
        (async () => {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
                const response = await fetch(`${this.pfpkApiUrl}/bech32/${hex}`, {
                    signal: controller.signal,
                    headers: { 'accept': 'application/json' },
                });
                clearTimeout(timeout);
                if (response.ok) {
                    const data = await response.json();
                    if (data && data.name) {
                        this.cache.set(address, { time: Date.now(), value: `@${data.name}` });
                        return;
                    }
                }
                const short = address.length <= 16 ? address : `${address.slice(0, 8)}...${address.slice(-6)}`;
                this.cache.set(address, { time: Date.now(), value: short });
            } catch (error) {
                const short = address.length <= 16 ? address : `${address.slice(0, 8)}...${address.slice(-6)}`;
                this.cache.set(address, { time: Date.now(), value: short });
            }
        })();
        const short = address.length <= 16 ? address : `${address.slice(0, 8)}...${address.slice(-6)}`;
        return short;
    }

    resolveSync(address) {
        return this.resolve(address);
    }
}

module.exports = { NameResolver, bech32ToHex };
