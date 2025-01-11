const ethers = require('ethers');
const Web3 = require('web3');
const dotenv = require('dotenv');
const yieldFarmingABI = require('./artifacts/contracts/YieldFarming.sol/YieldFarming.json').abi;

class YieldFarmingService {
    constructor() {
        dotenv.config();
        this.provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
        this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);
        this.contractAddress = process.env.YIELD_FARMING_ADDRESS;
    }

    async initializeContract() {
        this.contract = new ethers.Contract(
            this.contractAddress,
            yieldFarmingABI,
            this.provider
        );
        this.contractWithSigner = this.contract.connect(this.wallet);
    }

    async createPool(lpToken, rewardTokens, rewardRates, startTime, endTime, multiplierFactor) {
        const tx = await this.contractWithSigner.createPool(
            lpToken,
            rewardTokens,
            rewardRates,
            startTime,
            endTime,
            multiplierFactor
        );
        return await tx.wait();
    }

    async stake(poolId, amount) {
        const pool = await this.contract.farmPools(poolId);
        const lpToken = new ethers.Contract(
            pool.lpToken,
            ['function approve(address spender, uint256 amount) external returns (bool)'],
            this.wallet
        );

        await lpToken.approve(this.contractAddress, amount);
        const tx = await this.contractWithSigner.stake(poolId, amount);
        return await tx.wait();
    }

    async withdraw(poolId, amount) {
        const tx = await this.contractWithSigner.withdraw(poolId, amount);
        return await tx.wait();
    }

    async claimRewards(poolId) {
        const tx = await this.contractWithSigner.claimRewards(poolId);
        return await tx.wait();
    }

    async getPoolInfo(poolId) {
        const pool = await this.contract.farmPools(poolId);
        return {
            lpToken: pool.lpToken,
            rewardTokens: pool.rewardTokens,
            rewardRates: pool.rewardRates.map(r => r.toString()),
            totalStaked: ethers.utils.formatEther(pool.totalStaked),
            startTime: new Date(pool.startTime.toNumber() * 1000),
            endTime: new Date(pool.endTime.toNumber() * 1000),
            isActive: pool.isActive
        };
    }

    async getUserInfo(poolId, address) {
        const user = await this.contract.userInfo(poolId, address);
        return {
            stakedAmount: ethers.utils.formatEther(user.amount),
            rewardDebt: user.rewardDebt.map(r => ethers.utils.formatEther(r)),
            lastClaimTime: new Date(user.lastClaimTime.toNumber() * 1000),
            boostMultiplier: user.boostMultiplier.toString(),
            autoCompound: user.autoCompound
        };
    }

    async getPendingRewards(poolId, address) {
        const pool = await this.contract.farmPools(poolId);
        const pendingRewards = [];
        
        for (let i = 0; i < pool.rewardTokens.length; i++) {
            const reward = await this.contract.pendingReward(poolId, address, i);
            pendingRewards.push(ethers.utils.formatEther(reward));
        }
        
        return pendingRewards;
    }

    async getAPR(poolId) {
        const pool = await this.contract.farmPools(poolId);
        const totalStaked = pool.totalStaked;
        
        if (totalStaked.isZero()) return 0;
        
        const yearlyRewards = pool.rewardRates.map(rate => 
            rate.mul(365 * 24 * 60 * 60)
        );
        
        // Calculate APR for each reward token
        const aprs = await Promise.all(yearlyRewards.map(async (reward, index) => {
            const rewardValue = reward.mul(await this.getTokenPrice(pool.rewardTokens[index]));
            const stakedValue = totalStaked.mul(await this.getTokenPrice(pool.lpToken));
            return rewardValue.mul(100).div(stakedValue).toNumber();
        }));
        
        return aprs.reduce((a, b) => a + b, 0);
    }

    async getTokenPrice(tokenAddress) {
        // Implement price fetching logic
        return ethers.utils.parseEther("1");
    }

    async listenToEvents() {
        this.contract.on("PoolCreated", (poolId, lpToken, event) => {
            console.log(`
                New Farm Pool Created:
                Pool ID: ${poolId}
                LP Token: ${lpToken}
            `);
        });

        this.contract.on("Staked", (poolId, user, amount, event) => {
            console.log(`
                Tokens Staked:
                Pool ID: ${poolId}
                User: ${user}
                Amount: ${ethers.utils.formatEther(amount)}
            `);
        });

        this.contract.on("RewardsClaimed", (poolId, user, rewards, event) => {
            console.log(`
                Rewards Claimed:
                Pool ID: ${poolId}
                User: ${user}
                Rewards: ${rewards.map(r => ethers.utils.formatEther(r))}
            `);
        });
    }
}

module.exports = YieldFarmingService; 