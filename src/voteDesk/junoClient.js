class JunoClient {
    constructor(lcdUrl) {
        this.lcdUrl = lcdUrl.replace(/\/+$/, '');
    }

    async queryContract(address, query) {
        if (!address) throw new Error('Cannot query a DAO contract without its address');
        const encodedQuery = Buffer.from(JSON.stringify(query)).toString('base64');
        const url = `${this.lcdUrl}/cosmwasm/wasm/v1/contract/${encodeURIComponent(address)}/smart/${encodedQuery}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        const body = await response.json();
        if (!response.ok || body.code || body.data === undefined) {
            throw new Error(`Juno contract query failed (${response.status}): ${JSON.stringify(body)}`);
        }
        return body.data;
    }

    async latestBlock() {
        const response = await fetch(`${this.lcdUrl}/cosmos/base/tendermint/v1beta1/blocks/latest`, {
            signal: AbortSignal.timeout(15000),
        });
        const body = await response.json();
        if (!response.ok || !body.block?.header?.height || !body.block?.header?.time) {
            throw new Error(`Juno latest-block query failed (${response.status}): ${JSON.stringify(body)}`);
        }
        return {
            height: BigInt(body.block.header.height),
            time: new Date(body.block.header.time),
        };
    }
}

module.exports = { JunoClient };
