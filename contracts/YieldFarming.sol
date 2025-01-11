// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";

contract YieldFarming is ReentrancyGuard, Ownable, Pausable {
    using SafeMath for uint256;

    struct FarmPool {
        IERC20 lpToken;           // LP token to stake
        IERC20[] rewardTokens;    // Multiple reward tokens
        uint256[] rewardRates;    // Reward per second for each token
        uint256 totalStaked;
        uint256 lastUpdateTime;
        uint256[] accRewardPerShare;
        bool isActive;
        uint256 startTime;
        uint256 endTime;
        uint256 multiplierFactor; // For boosted rewards
    }

    struct UserInfo {
        uint256 amount;           // LP tokens staked
        uint256[] rewardDebt;     // Reward debt for each token
        uint256 lastClaimTime;
        uint256 boostMultiplier;  // User's personal boost
        bool autoCompound;
    }

    mapping(uint256 => FarmPool) public farmPools;
    mapping(uint256 => mapping(address => UserInfo)) public userInfo;
    mapping(address => uint256[]) public userPools;
    
    uint256 public poolCount;
    uint256 public constant PRECISION = 1e12;
    uint256 public minStakeAmount;
    uint256 public harvestCooldown;
    
    // Boost related
    IERC20 public governanceToken;
    uint256 public maxBoostFactor;
    mapping(address => uint256) public userBoostPoints;

    event PoolCreated(uint256 indexed pid, address lpToken);
    event Staked(uint256 indexed pid, address indexed user, uint256 amount);
    event Withdrawn(uint256 indexed pid, address indexed user, uint256 amount);
    event RewardsClaimed(uint256 indexed pid, address indexed user, uint256[] rewards);
    event BoostUpdated(address indexed user, uint256 newBoost);

    constructor(
        address _governanceToken,
        uint256 _minStakeAmount,
        uint256 _harvestCooldown,
        uint256 _maxBoostFactor
    ) {
        governanceToken = IERC20(_governanceToken);
        minStakeAmount = _minStakeAmount;
        harvestCooldown = _harvestCooldown;
        maxBoostFactor = _maxBoostFactor;
    }

    function createPool(
        address _lpToken,
        address[] memory _rewardTokens,
        uint256[] memory _rewardRates,
        uint256 _startTime,
        uint256 _endTime,
        uint256 _multiplierFactor
    ) external onlyOwner {
        require(_rewardTokens.length == _rewardRates.length, "Array length mismatch");
        require(_startTime >= block.timestamp, "Invalid start time");
        require(_endTime > _startTime, "Invalid end time");

        uint256[] memory accRewardPerShare = new uint256[](_rewardTokens.length);
        
        farmPools[poolCount] = FarmPool({
            lpToken: IERC20(_lpToken),
            rewardTokens: new IERC20[](_rewardTokens.length),
            rewardRates: _rewardRates,
            totalStaked: 0,
            lastUpdateTime: _startTime,
            accRewardPerShare: accRewardPerShare,
            isActive: true,
            startTime: _startTime,
            endTime: _endTime,
            multiplierFactor: _multiplierFactor
        });

        for (uint256 i = 0; i < _rewardTokens.length; i++) {
            farmPools[poolCount].rewardTokens[i] = IERC20(_rewardTokens[i]);
        }

        emit PoolCreated(poolCount, _lpToken);
        poolCount++;
    }

    function stake(uint256 _pid, uint256 _amount) external nonReentrant whenNotPaused {
        require(farmPools[_pid].isActive, "Pool not active");
        require(_amount >= minStakeAmount, "Amount too low");
        require(block.timestamp >= farmPools[_pid].startTime, "Pool not started");
        require(block.timestamp <= farmPools[_pid].endTime, "Pool ended");

        updatePool(_pid);
        FarmPool storage pool = farmPools[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];

        if (user.amount > 0) {
            claimRewards(_pid);
        }

        pool.lpToken.transferFrom(msg.sender, address(this), _amount);
        user.amount = user.amount.add(_amount);
        pool.totalStaked = pool.totalStaked.add(_amount);

        updateRewardDebt(_pid, msg.sender);
        
        if (!isUserInPool(msg.sender, _pid)) {
            userPools[msg.sender].push(_pid);
        }

        emit Staked(_pid, msg.sender, _amount);
    }

    function withdraw(uint256 _pid, uint256 _amount) external nonReentrant {
        FarmPool storage pool = farmPools[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];
        require(user.amount >= _amount, "Insufficient balance");

        updatePool(_pid);
        claimRewards(_pid);

        user.amount = user.amount.sub(_amount);
        pool.totalStaked = pool.totalStaked.sub(_amount);
        
        updateRewardDebt(_pid, msg.sender);
        pool.lpToken.transfer(msg.sender, _amount);

        emit Withdrawn(_pid, msg.sender, _amount);
    }

    function claimRewards(uint256 _pid) public nonReentrant {
        require(
            block.timestamp >= userInfo[_pid][msg.sender].lastClaimTime + harvestCooldown,
            "Harvest cooldown active"
        );

        updatePool(_pid);
        FarmPool storage pool = farmPools[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];
        
        uint256[] memory pendingRewards = new uint256[](pool.rewardTokens.length);
        
        for (uint256 i = 0; i < pool.rewardTokens.length; i++) {
            uint256 pending = pendingReward(_pid, msg.sender, i);
            if (pending > 0) {
                pendingRewards[i] = pending;
                pool.rewardTokens[i].transfer(msg.sender, pending);
            }
        }

        user.lastClaimTime = block.timestamp;
        updateRewardDebt(_pid, msg.sender);

        emit RewardsClaimed(_pid, msg.sender, pendingRewards);
    }

    // Internal functions
    function updatePool(uint256 _pid) internal {
        FarmPool storage pool = farmPools[_pid];
        if (block.timestamp <= pool.lastUpdateTime) return;

        if (pool.totalStaked == 0) {
            pool.lastUpdateTime = block.timestamp;
            return;
        }

        uint256 timeElapsed = block.timestamp.sub(pool.lastUpdateTime);
        
        for (uint256 i = 0; i < pool.rewardTokens.length; i++) {
            uint256 reward = timeElapsed.mul(pool.rewardRates[i]);
            pool.accRewardPerShare[i] = pool.accRewardPerShare[i].add(
                reward.mul(PRECISION).div(pool.totalStaked)
            );
        }
        
        pool.lastUpdateTime = block.timestamp;
    }

    function updateRewardDebt(uint256 _pid, address _user) internal {
        UserInfo storage user = userInfo[_pid][msg.sender];
        FarmPool storage pool = farmPools[_pid];

        for (uint256 i = 0; i < pool.rewardTokens.length; i++) {
            user.rewardDebt[i] = user.amount.mul(pool.accRewardPerShare[i]).div(PRECISION);
        }
    }

    // View functions
    function pendingReward(uint256 _pid, address _user, uint256 _rewardIndex) 
        public view returns (uint256) 
    {
        FarmPool storage pool = farmPools[_pid];
        UserInfo storage user = userInfo[_pid][_user];

        uint256 accRewardPerShare = pool.accRewardPerShare[_rewardIndex];
        
        if (block.timestamp > pool.lastUpdateTime && pool.totalStaked != 0) {
            uint256 timeElapsed = block.timestamp.sub(pool.lastUpdateTime);
            uint256 reward = timeElapsed.mul(pool.rewardRates[_rewardIndex]);
            accRewardPerShare = accRewardPerShare.add(
                reward.mul(PRECISION).div(pool.totalStaked)
            );
        }

        uint256 baseReward = user.amount.mul(accRewardPerShare).div(PRECISION)
            .sub(user.rewardDebt[_rewardIndex]);
            
        return applyBoost(baseReward, user.boostMultiplier);
    }

    function applyBoost(uint256 _baseAmount, uint256 _boost) internal pure returns (uint256) {
        return _baseAmount.mul(_boost.add(100)).div(100);
    }

    function isUserInPool(address _user, uint256 _pid) internal view returns (bool) {
        uint256[] storage userPoolIds = userPools[_user];
        for (uint256 i = 0; i < userPoolIds.length; i++) {
            if (userPoolIds[i] == _pid) return true;
        }
        return false;
    }

    // Admin functions
    function updatePoolRewardRate(uint256 _pid, uint256[] memory _newRates) external onlyOwner {
        FarmPool storage pool = farmPools[_pid];
        require(_newRates.length == pool.rewardTokens.length, "Invalid rates length");
        
        updatePool(_pid);
        pool.rewardRates = _newRates;
    }

    function setHarvestCooldown(uint256 _newCooldown) external onlyOwner {
        harvestCooldown = _newCooldown;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
} 