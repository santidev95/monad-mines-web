// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Interfaces necessárias (OpenZeppelin e Pyth)
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";
import "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import "@pythnetwork/entropy-sdk-solidity/EntropyStructsV2.sol";

library EntropyTestErrors {
    error IncorrectSender();

    error InsufficientFee();
}

contract EntropyTest is IEntropyConsumer {
    IEntropyV2 public entropy;

    event TestEventRequest(uint64 sequenceNumber);
    event TestEventCallback(uint64 sequenceNumber, uint256 randomNumber, bool isHeads);

    constructor(address _entropy) {
        entropy = IEntropyV2(_entropy);
    }       

    function play() external payable {
        uint256 fee = entropy.getFeeV2();

        if (msg.value < fee) {
            revert EntropyTestErrors.InsufficientFee();
        }

        uint64 sequenceNumber = entropy.requestV2{value: fee}();
        emit TestEventRequest(sequenceNumber);
    }

    function entropyCallback(
    uint64 sequenceNumber,
    address,
    bytes32 randomNumber
    ) internal override {
        bool isHeads = uint256(randomNumber) % 2 == 0;
        emit TestEventCallback(sequenceNumber,uint256(randomNumber), isHeads);        
    }

    function getFee() public view returns (uint256) {
        return entropy.getFeeV2();
    }

    function getEntropy() internal view override returns (address) {
        return address(entropy);
    }

    receive() external payable {}
    
}