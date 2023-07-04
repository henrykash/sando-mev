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

  match = (a: any, b: any, caseIncensitive = true) => {
    if (a === null || a === undefined) return false;

    if (Array.isArray(b)) {
      if (caseIncensitive) {
        return b.map((x) => x.toLowerCase()).includes(a.toLowerCase());
      }

      return b.includes(a);
    }

    if (caseIncensitive) {
      return a.toLowerCase() === b.toLowerCase();
    }

    return a === b;
  };
}

export const HelpersWrapper = new Helpers();
