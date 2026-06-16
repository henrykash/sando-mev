// Minimal solc compile + artifact emit, so the executor contract is validated
// in CI without pulling in a full Hardhat/Foundry toolchain.
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const CONTRACTS_DIR = path.join(__dirname, "..", "contracts");
const OUT_DIR = path.join(__dirname, "..", "artifacts");

function main() {
  const sources = {};
  for (const file of fs.readdirSync(CONTRACTS_DIR)) {
    if (file.endsWith(".sol")) {
      sources[file] = {
        content: fs.readFileSync(path.join(CONTRACTS_DIR, file), "utf8"),
      };
    }
  }

  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 1_000_000 }, // hot path: optimise for runtime gas
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length) {
    for (const e of errors) console.error(e.formattedMessage);
    process.exit(1);
  }
  for (const w of output.errors || []) console.warn(w.formattedMessage);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [file, contracts] of Object.entries(output.contracts)) {
    for (const [name, c] of Object.entries(contracts)) {
      const artifact = {
        contractName: name,
        abi: c.abi,
        bytecode: "0x" + c.evm.bytecode.object,
      };
      fs.writeFileSync(
        path.join(OUT_DIR, `${name}.json`),
        JSON.stringify(artifact, null, 2)
      );
      console.log(`compiled ${file}:${name} -> artifacts/${name}.json`);
    }
  }
}

main();
