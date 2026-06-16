// Provide dummy connection env so importing `config` during tests doesn't fail
// its required-var check. No network is touched — these URLs are never dialed.
process.env.RPC_URL = process.env.RPC_URL || "http://localhost:8545";
process.env.WSS_URL = process.env.WSS_URL || "ws://localhost:8546";
