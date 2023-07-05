import { ethers } from "ethers";

class Helpers {
  constructor() {}

  calculateNextBlockBaseFee = async (currentBlock: any) => {
    const basefee = currentBlock.baseFeePerGas;
    const gasUsed = currentBlock.gasUsed;
    const targetGasUsed = currentBlock.gasLimit.div(2);
    const delta = gasUsed.sub(targetGasUsed);

    const newBaseFee = basefee.add(
      basefee.mul(delta).div(targetGasUsed).div(ethers.BigNumber.from(8))
    );

    //add 0-9 wei so it becomes a different hash each time
    const rand = Math.floor(Math.random() * 10);

    return newBaseFee.add(rand);
  };

}

export const HelpersWrapper = new Helpers();
