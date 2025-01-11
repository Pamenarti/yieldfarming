const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Yield Farming", function () {
    let YieldFarming, farming;
    let TestToken, lpToken, rewardToken1, rewardToken2;
    let owner, user1, user2;
    
    const INITIAL_SUPPLY = ethers.utils.parseEther("1000000");
    const REWARD_RATE = ethers.utils.parseEther("0.1");
    const MIN_STAKE = ethers.utils.parseEther("100");
    const HARVEST_COOLDOWN = 24 * 60 * 60; // 24 hours
    const MAX_BOOST = 200; // 2x boost
    
    beforeEach(async function () {
        [owner, user1, user2] = await ethers.getSigners();
        
        // Deploy test tokens
        TestToken = await ethers.getContractFactory("TestToken");
        lpToken = await TestToken.deploy("LP Token", "LP");
        rewardToken1 = await TestToken.deploy("Reward Token 1", "RWD1");
        rewardToken2 = await TestToken.deploy("Reward Token 2", "RWD2");
        
        await Promise.all([
            lpToken.deployed(),
            rewardToken1.deployed(),
            rewardToken2.deployed()
        ]);
        
        // Mint tokens
        await lpToken.mint(user1.address, INITIAL_SUPPLY);
        await rewardToken1.mint(owner.address, INITIAL_SUPPLY);
        await rewardToken2.mint(owner.address, INITIAL_SUPPLY);
        
        // Deploy farming contract
        YieldFarming = await ethers.getContractFactory("YieldFarming");
        farming = await YieldFarming.deploy(
            rewardToken1.address,
            MIN_STAKE,
            HARVEST_COOLDOWN,
            MAX_BOOST
        );
        await farming.deployed();
        
        // Create farming pool
        const startTime = (await ethers.provider.getBlock()).timestamp + 60;
        const endTime = startTime + 30 * 24 * 60 * 60; // 30 days
        
        await farming.createPool(
            lpToken.address,
            [rewardToken1.address, rewardToken2.address],
            [REWARD_RATE, REWARD_RATE],
            startTime,
            endTime,
            100 // 1x multiplier
        );
        
        // Fund reward pool
        await rewardToken1.approve(farming.address, INITIAL_SUPPLY);
        await rewardToken2.approve(farming.address, INITIAL_SUPPLY);
    });
    
    describe("Pool Creation", function () {
        it("Should create pool with correct parameters", async function () {
            const pool = await farming.farmPools(0);
            
            expect(pool.lpToken).to.equal(lpToken.address);
            expect(pool.rewardTokens[0]).to.equal(rewardToken1.address);
            expect(pool.rewardTokens[1]).to.equal(rewardToken2.address);
            expect(pool.rewardRates[0]).to.equal(REWARD_RATE);
            expect(pool.rewardRates[1]).to.equal(REWARD_RATE);
            expect(pool.isActive).to.be.true;
        });
    });
    
    describe("Staking", function () {
        const stakeAmount = ethers.utils.parseEther("1000");
        
        beforeEach(async function () {
            await lpToken.connect(user1).approve(
                farming.address,
                stakeAmount
            );
            
            // Fast forward to start time
            await network.provider.send("evm_increaseTime", [61]);
            await network.provider.send("evm_mine");
        });
        
        it("Should stake LP tokens correctly", async function () {
            await expect(
                farming.connect(user1).stake(0, stakeAmount)
            ).to.emit(farming, "Staked")
             .withArgs(0, user1.address, stakeAmount);
            
            const userInfo = await farming.userInfo(0, user1.address);
            expect(userInfo.amount).to.equal(stakeAmount);
        });
        
        it("Should fail if amount below minimum", async function () {
            await expect(
                farming.connect(user1).stake(0, MIN_STAKE.sub(1))
            ).to.be.revertedWith("Amount too low");
        });
    });
    
    describe("Rewards", function () {
        const stakeAmount = ethers.utils.parseEther("1000");
        
        beforeEach(async function () {
            await lpToken.connect(user1).approve(farming.address, stakeAmount);
            await network.provider.send("evm_increaseTime", [61]);
            await network.provider.send("evm_mine");
            await farming.connect(user1).stake(0, stakeAmount);
        });
        
        it("Should accumulate rewards correctly", async function () {
            await network.provider.send("evm_increaseTime", [24 * 60 * 60]);
            await network.provider.send("evm_mine");
            
            const pending1 = await farming.pendingReward(0, user1.address, 0);
            const pending2 = await farming.pendingReward(0, user1.address, 1);
            
            expect(pending1).to.be.gt(0);
            expect(pending2).to.be.gt(0);
        });
        
        it("Should claim rewards successfully", async function () {
            await network.provider.send("evm_increaseTime", [24 * 60 * 60]);
            await network.provider.send("evm_mine");
            
            await farming.connect(user1).claimRewards(0);
            
            const balance1 = await rewardToken1.balanceOf(user1.address);
            const balance2 = await rewardToken2.balanceOf(user1.address);
            
            expect(balance1).to.be.gt(0);
            expect(balance2).to.be.gt(0);
        });
        
        it("Should respect harvest cooldown", async function () {
            await farming.connect(user1).claimRewards(0);
            
            await expect(
                farming.connect(user1).claimRewards(0)
            ).to.be.revertedWith("Harvest cooldown active");
        });
    });
}); 