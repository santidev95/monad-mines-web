// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Required interfaces (OpenZeppelin and Pyth)
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";
import "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import "@pythnetwork/entropy-sdk-solidity/EntropyStructsV2.sol";

contract MonadMines is IEntropyConsumer, Ownable, ReentrancyGuard {
    IEntropyV2 public entropy;

    // --- Game Configuration ---
    // Mine probability: 2000 = 20.00% (Base 10000)
    uint256 public MINE_PROBABILITY = 2000; 
    // Reward multiplier: 1.20x per click (Base 10000 -> 12000)
    uint256 public REWARD_MULTIPLIER = 12000; 
    uint256 public constant BASE_DIVISOR = 10000;

    // --- Commit-Reveal Configuration ---
    // Minimum delay before parameters can be changed (24 hours)
    uint256 public constant PARAM_CHANGE_DELAY = 24 hours;
    // Limits for parameter changes
    uint256 public constant MIN_MINE_PROBABILITY = 100;  // 1%
    uint256 public constant MAX_MINE_PROBABILITY = 5000; // 50%
    uint256 public constant MIN_REWARD_MULTIPLIER = 10000; // 1.0x (no gain)
    uint256 public constant MAX_REWARD_MULTIPLIER = 20000; // 2.0x

    // Pending parameter changes (with timelock)
    struct PendingChange {
        uint256 newValue;
        uint256 changeTime;  // When the change can be executed
    }
    PendingChange public pendingMineProbability;
    PendingChange public pendingRewardMultiplier;

    // --- Game Structure ---
    struct Game {
        address player;         // Game owner
        uint256 currentPot;     // Current accumulated value (can be withdrawn)
        bytes32 seed;           // Final seed (hash of Pyth seed + player nonce)
        bytes32 pythSeed;       // Seed from Pyth (stored temporarily)
        bytes32 playerNonce;    // Player's nonce for commit-reveal
        bytes32 nonceCommit;    // Commit hash of the nonce
        uint256 revealedCells;  // 256-bit bitmap (records where already clicked)
        bool isActive;          // Game in progress?
        bool isLost;            // Exploded?
        bool nonceRevealed;     // Whether player nonce has been revealed
    }

    // Game ID (Pyth Sequence Number) => Game Data
    mapping(uint64 => Game) public games;

    // --- Session Keys (The UX magic) ---
    // Session Key Address => Main User Address
    mapping(address => address) public sessionDelegates;

    // --- Eventos ---
    event SessionKeyRegistered(address indexed user, address indexed sessionKey);
    event SessionKeyRevoked(address indexed user, address indexed sessionKey);
    event GameRequested(uint64 indexed gameId, address indexed player, bytes32 nonceCommit);
    event GameStarted(uint64 indexed gameId);
    event NonceRevealed(uint64 indexed gameId, bytes32 playerNonce);
    event CellRevealed(uint64 indexed gameId, uint8 x, uint8 y, bool isMine, uint256 newPot);
    event GameOver(uint64 indexed gameId, address indexed player, uint256 finalPayout, bool isWin);
    event ParameterChangeProposed(string parameter, uint256 newValue, uint256 executeTime);
    event ParameterChanged(string parameter, uint256 newValue);

    constructor(address _entropy) Ownable(msg.sender) {
        entropy = IEntropyV2(_entropy);
    }

    
    // =============================================================
    // 1. SESSION KEY MANAGEMENT (UX)
    // =============================================================

    /**
     * @dev The main user authorizes a temporary browser key.
     * This allows the frontend to sign transactions automatically.
     */
    function registerSessionKey(address _sessionKey) external {
        require(_sessionKey != address(0), "Session key cannot be zero");
        require(_sessionKey != msg.sender, "Cannot delegate to self");
        sessionDelegates[_sessionKey] = msg.sender;
        emit SessionKeyRegistered(msg.sender, _sessionKey);
    }

    /**
     * @dev Revokes a previously registered session key.
     */
    function revokeSessionKey(address _sessionKey) external {
        require(sessionDelegates[_sessionKey] == msg.sender, "Not your session key");
        delete sessionDelegates[_sessionKey];
        emit SessionKeyRevoked(msg.sender, _sessionKey);
    }

    // =============================================================
    // 2. GAME START (PYTH INTEGRATION)
    // =============================================================

    /**
     * @dev Pays Pyth fee + bet and requests randomness.
     * @param nonceCommit Hash of the player's secret nonce (keccak256(nonce))
     * The player will reveal the actual nonce later to generate the final seed.
     */
    function startGame(bytes32 nonceCommit) external payable returns (uint64) {
        uint256 pythFee = entropy.getFeeV2();
        require(msg.value > pythFee, "Sent value must cover fee + bet");

        uint256 betAmount = msg.value - pythFee;
        require(betAmount > 0, "Bet must be greater than zero");

        // 1. Request entropy from Pyth
        uint64 sequenceNumber = entropy.requestV2{value: pythFee}();

        // 2. Check if game already exists (protection against overwrite)
        require(games[sequenceNumber].player == address(0), "Game ID already exists");

        // 3. Create initial game state (still locked waiting for callback)
        games[sequenceNumber] = Game({
            player: msg.sender,
            currentPot: betAmount,        // Pot starts with the bet
            seed: bytes32(0),             // Final seed (will be computed after nonce reveal)
            pythSeed: bytes32(0),         // Waiting for Pyth...
            playerNonce: bytes32(0),      // Will be revealed later
            nonceCommit: nonceCommit,     // Commit hash stored
            revealedCells: 0,             // Empty bitmap
            isActive: true,
            isLost: false,
            nonceRevealed: false
        });

        emit GameRequested(sequenceNumber, msg.sender, nonceCommit);
        return sequenceNumber;
    }

    /**
     * @dev Callback called by Pyth contract when random number is ready.
     * Seed is not finalized until player reveals their nonce.
     */
    function entropyCallback(
        uint64 sequenceNumber,
        address, // provider (not used here)
        bytes32 randomNumber
    ) internal override {
        Game storage game = games[sequenceNumber];
        
        // Store Pyth seed (will be combined with player nonce later in revealNonce)
        game.pythSeed = randomNumber;
        
        emit GameStarted(sequenceNumber);
    }

    /**
     * @dev Player reveals their nonce to finalize the game seed.
     * @param gameId The game ID
     * @param nonce The secret nonce that was committed in startGame
     */
    function revealNonce(uint64 gameId, bytes32 nonce) external isAuthorized(gameId) {
        Game storage game = games[gameId];
        
        require(game.isActive, "Game finished");
        require(!game.nonceRevealed, "Nonce already revealed");
        require(game.pythSeed != bytes32(0), "Waiting for Pyth seed");
        
        // Verify the commit matches
        bytes32 commitHash = keccak256(abi.encodePacked(nonce));
        require(commitHash == game.nonceCommit, "Invalid nonce: commit mismatch");
        
        // Store the revealed nonce
        game.playerNonce = nonce;
        game.nonceRevealed = true;
        
        // Generate final seed: hash(Pyth_seed || player_nonce || player_address)
        // This ensures the seed cannot be calculated by others before reveal
        game.seed = keccak256(abi.encodePacked(game.pythSeed, nonce, game.player));
        
        emit NonceRevealed(gameId, nonce);
    }

    // =============================================================
    // 3. CORE LOOP: CLICK & CHECK
    // =============================================================

    /**
     * @dev The main transaction. Can be called by Session Key.
     * @param x X coordinate (0-9)
     * @param y Y coordinate (0-9)
     * @param nonce The player's nonce (only required on first reveal, can be bytes32(0) after)
     */
    function revealCell(uint64 gameId, uint8 x, uint8 y, bytes32 nonce) 
        external          
        isAuthorized(gameId) 
    {
        Game storage game = games[gameId];
        
        // Validations
        require(game.isActive, "Game finished");
        require(game.pythSeed != bytes32(0), "Waiting for Pyth seed");
        require(!game.isLost, "You already lost");
        require(x < 10 && y < 10, "Invalid coordinates");
        
        // If nonce not revealed yet, reveal it now (must be done on first cell reveal)
        if (!game.nonceRevealed) {
            require(nonce != bytes32(0), "Nonce required for first reveal");
            require(game.pythSeed != bytes32(0), "Waiting for Pyth seed");
            
            // Verify the commit matches
            bytes32 commitHash = keccak256(abi.encodePacked(nonce));
            require(commitHash == game.nonceCommit, "Invalid nonce: commit mismatch");
            
            // Store the revealed nonce
            game.playerNonce = nonce;
            game.nonceRevealed = true;
            
            // Generate final seed: hash(Pyth_seed || player_nonce || player_address)
            game.seed = keccak256(abi.encodePacked(game.pythSeed, nonce, game.player));
            
            emit NonceRevealed(gameId, nonce);
        } else {
            // Nonce already revealed, seed must be ready
            require(game.seed != bytes32(0), "Seed not ready");
        }

        // Check Bitmap: If already clicked here, revert to avoid wasting gas or check duplicate
        uint256 cellIndex = uint256(y) * 10 + uint256(x);
        uint256 cellMask = 1 << cellIndex;
        require((game.revealedCells & cellMask) == 0, "Cell already revealed");

        // Mark the cell as revealed in the Bitmap
        game.revealedCells |= cellMask;

        // --- MOMENT OF TRUTH ---
        bool isMine = _isMine(game.seed, x, y);

        if (isMine) {
            // EXPLODED!
            game.isActive = false;
            game.isLost = true;
            game.currentPot = 0; // Lose everything
            
            emit CellRevealed(gameId, x, y, true, 0);
            emit GameOver(gameId, game.player, 0, false);
        } else {
            // SAFE!
            // Apply multiplier to current pot
            // Ex: Bet 10. Multiplier 1.2x.
            // Click 1: 10 * 1.2 = 12
            // Click 2: 12 * 1.2 = 14.4
            game.currentPot = (game.currentPot * REWARD_MULTIPLIER) / BASE_DIVISOR;

            emit CellRevealed(gameId, x, y, false, game.currentPot);
        }
    }

    /**
     * @dev Player decides to stop and take the money.
     */
    function cashOut(uint64 gameId) 
        external          
        isAuthorized(gameId)
        nonReentrant
    {
        Game storage game = games[gameId];
        
        require(game.isActive, "Game inactive");
        require(game.nonceRevealed, "Nonce must be revealed first");
        require(!game.isLost, "You lost, cannot withdraw");
        
        uint256 payout = game.currentPot;
        
        // End the game
        game.isActive = false;
        
        // Transfer to MAIN player (never to session key)
        (bool sent, ) = game.player.call{value: payout}("");
        require(sent, "Failed to send funds");

        emit GameOver(gameId, game.player, payout, true);
    }

    // =============================================================
    // 4. VIEW FUNCTIONS (GAME STATE RECOVERY)
    // =============================================================

    /**
     * @dev Returns all revealed safe cells for a game.
     * Useful for recovering game state after page refresh.
     * @param gameId The game ID
     * @return safeCells Array of coordinates [x, y] that are safe and revealed
     */
    function getRevealedSafeCells(uint64 gameId) external view returns (uint8[] memory) {
        Game memory game = games[gameId];
        
        // If game doesn't exist, lost, or seed not ready, return empty
        if (game.player == address(0) || game.isLost || !game.nonceRevealed || game.seed == bytes32(0)) {
            return new uint8[](0);
        }

        // Count safe cells first
        uint256 safeCount = 0;
        for (uint8 y = 0; y < 10; y++) {
            for (uint8 x = 0; x < 10; x++) {
                uint256 cellIndex = uint256(y) * 10 + uint256(x);
                uint256 cellMask = 1 << cellIndex;
                
                // If cell is revealed and safe
                if ((game.revealedCells & cellMask) != 0) {
                    if (!_isMine(game.seed, x, y)) {
                        safeCount++;
                    }
                }
            }
        }

        // Build array of safe cells
        uint8[] memory safeCells = new uint8[](safeCount * 2);
        uint256 index = 0;
        
        for (uint8 y = 0; y < 10; y++) {
            for (uint8 x = 0; x < 10; x++) {
                uint256 cellIndex = uint256(y) * 10 + uint256(x);
                uint256 cellMask = 1 << cellIndex;
                
                // If cell is revealed and safe
                if ((game.revealedCells & cellMask) != 0) {
                    if (!_isMine(game.seed, x, y)) {
                        safeCells[index] = x;
                        safeCells[index + 1] = y;
                        index += 2;
                    }
                }
            }
        }

        return safeCells;
    }

    /**
     * @dev Returns complete game state information.
     * NOTE: seed is only returned if nonce has been revealed and game is finished.
     * This prevents players from calculating mines before revealing.
     * @param gameId The game ID
     * @return player Game owner address
     * @return currentPot Current pot value
     * @return seed Game seed (0 if not ready or game still active)
     * @return isActive Whether game is active
     * @return isLost Whether player lost
     * @return revealedCells Bitmap of revealed cells
     * @return nonceRevealed Whether player nonce has been revealed
     */
    function getGameState(uint64 gameId) external view returns (
        address player,
        uint256 currentPot,
        bytes32 seed,
        bool isActive,
        bool isLost,
        uint256 revealedCells,
        bool nonceRevealed
    ) {
        Game memory game = games[gameId];
        
        // Only return seed if game is finished (won or lost)
        // This prevents calculating mines during active gameplay
        bytes32 safeSeed = (!game.isActive || game.isLost) && game.nonceRevealed ? game.seed : bytes32(0);
        
        return (
            game.player,
            game.currentPot,
            safeSeed,
            game.isActive,
            game.isLost,
            game.revealedCells,
            game.nonceRevealed
        );
    }

    /**
     * @dev Checks if a specific cell is revealed and safe.
     * @param gameId The game ID
     * @param x X coordinate
     * @param y Y coordinate
     * @return isRevealed Whether the cell has been revealed
     * @return isSafe Whether the cell is safe (not a mine)
     */
    function getCellStatus(uint64 gameId, uint8 x, uint8 y) external view returns (bool isRevealed, bool isSafe) {
        Game memory game = games[gameId];
        
        if (game.player == address(0) || !game.nonceRevealed || game.seed == bytes32(0)) {
            return (false, false);
        }

        uint256 cellIndex = uint256(y) * 10 + uint256(x);
        uint256 cellMask = 1 << cellIndex;
        isRevealed = (game.revealedCells & cellMask) != 0;
        
        if (isRevealed) {
            isSafe = !_isMine(game.seed, x, y);
        } else {
            isSafe = false; // Can't know if safe until revealed
        }
    }

    // =============================================================
    // 5. DETERMINISTIC MATHEMATICS
    // =============================================================

    /**
     * @dev Checks if there is a mine at the coordinate based on the game Seed.
     * @return true if mine, false if safe.
     */
    function _isMine(bytes32 seed, uint8 x, uint8 y) internal view returns (bool) {
        // Unique hash for this cell in this game
        bytes32 cellHash = keccak256(abi.encodePacked(seed, x, y));
        
        // Convert hash to number between 0 and 9999
        uint256 randomValue = uint256(cellHash) % 10000;
        
        // If randomValue is less than 2000 (20%), it's a bomb.
        return randomValue < MINE_PROBABILITY;
    }

    // Validates if caller is the owner OR the authorized key
    modifier isAuthorized(uint64 gameId) {
        address mainPlayer = games[gameId].player;
        require(mainPlayer != address(0), "Game does not exist");
        require(
            msg.sender == mainPlayer || sessionDelegates[msg.sender] == mainPlayer,
            "Not authorized: Only Player or SessionKey"
        );
        _;
    }   

    function getEntropy() internal view override returns (address) {
        return address(entropy);
    }

    // Allows owner to withdraw accumulated house profits (lost bets)
    function withdrawHouseFunds() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        address ownerAddress = owner();
        (bool success, ) = payable(ownerAddress).call{value: balance}("");
        require(success, "Transfer failed");
    }

    /**
     * @dev Proposes a change to mine probability (with timelock).
     * The change can only be executed after PARAM_CHANGE_DELAY.
     * @param _newProbability New probability (base 10000, ex: 2000 = 20%)
     */
    function proposeMineProbabilityChange(uint256 _newProbability) external onlyOwner {
        require(_newProbability >= MIN_MINE_PROBABILITY && _newProbability <= MAX_MINE_PROBABILITY, 
                "Probability out of allowed range");
        
        pendingMineProbability = PendingChange({
            newValue: _newProbability,
            changeTime: block.timestamp + PARAM_CHANGE_DELAY
        });
        
        emit ParameterChangeProposed("MINE_PROBABILITY", _newProbability, pendingMineProbability.changeTime);
    }

    /**
     * @dev Executes the pending mine probability change (after timelock).
     */
    function executeMineProbabilityChange() external onlyOwner {
        require(pendingMineProbability.changeTime > 0, "No pending change");
        require(block.timestamp >= pendingMineProbability.changeTime, "Timelock not expired");
        
        MINE_PROBABILITY = pendingMineProbability.newValue;
        uint256 executedValue = pendingMineProbability.newValue;
        
        // Clear pending change
        pendingMineProbability.changeTime = 0;
        pendingMineProbability.newValue = 0;
        
        emit ParameterChanged("MINE_PROBABILITY", executedValue);
    }

    /**
     * @dev Proposes a change to reward multiplier (with timelock).
     * The change can only be executed after PARAM_CHANGE_DELAY.
     * @param _newMultiplier New multiplier (base 10000, ex: 12000 = 1.2x)
     */
    function proposeRewardMultiplierChange(uint256 _newMultiplier) external onlyOwner {
        require(_newMultiplier >= MIN_REWARD_MULTIPLIER && _newMultiplier <= MAX_REWARD_MULTIPLIER, 
                "Multiplier out of allowed range");
        
        pendingRewardMultiplier = PendingChange({
            newValue: _newMultiplier,
            changeTime: block.timestamp + PARAM_CHANGE_DELAY
        });
        
        emit ParameterChangeProposed("REWARD_MULTIPLIER", _newMultiplier, pendingRewardMultiplier.changeTime);
    }

    /**
     * @dev Executes the pending reward multiplier change (after timelock).
     */
    function executeRewardMultiplierChange() external onlyOwner {
        require(pendingRewardMultiplier.changeTime > 0, "No pending change");
        require(block.timestamp >= pendingRewardMultiplier.changeTime, "Timelock not expired");
        
        REWARD_MULTIPLIER = pendingRewardMultiplier.newValue;
        uint256 executedValue = pendingRewardMultiplier.newValue;
        
        // Clear pending change
        pendingRewardMultiplier.changeTime = 0;
        pendingRewardMultiplier.newValue = 0;
        
        emit ParameterChanged("REWARD_MULTIPLIER", executedValue);
    }

    /**
     * @dev Cancels a pending parameter change (owner only).
     * @param isProbabilityChange true to cancel mine probability change, false for multiplier
     */
    function cancelPendingChange(bool isProbabilityChange) external onlyOwner {
        if (isProbabilityChange) {
            pendingMineProbability.changeTime = 0;
            pendingMineProbability.newValue = 0;
        } else {
            pendingRewardMultiplier.changeTime = 0;
            pendingRewardMultiplier.newValue = 0;
        }
    }

    receive() external payable {}
  
}