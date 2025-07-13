import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PredictionMarket } from "../target/types/prediction_market";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

/**
 * Deployment script for the Prediction Market smart contract
 */
async function deploy() {
  console.log("🚀 Starting Prediction Market deployment...");

  // Set up provider and program
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PredictionMarket as Program<PredictionMarket>;

  console.log("📍 Program ID:", program.programId.toString());
  console.log("👤 Authority:", provider.wallet.publicKey.toString());

  try {
    // Step 1: Derive global state PDA
    const [globalState] = PublicKey.findProgramAddressSync(
      [Buffer.from("global_state")],
      program.programId
    );

    console.log("🌍 Global State PDA:", globalState.toString());

    // Step 2: Set up fee recipient
    const feeRecipient = Keypair.generate();
    console.log("💰 Fee Recipient:", feeRecipient.publicKey.toString());

    // Step 3: Initialize platform
    const platformFeeBps = 250; // 2.5% fee
    console.log("⚙️ Initializing platform with", platformFeeBps / 100, "% fee...");

    const initSignature = await program.methods
      .initialize(platformFeeBps, feeRecipient.publicKey)
      .accounts({
        globalState,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("✅ Platform initialized successfully");
    console.log("📄 Transaction signature:", initSignature);

    // Step 4: Create a test token for demonstration
    console.log("🪙 Creating test token...");
    const mint = await createMint(
      provider.connection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      provider.wallet.publicKey,
      6 // 6 decimals
    );

    console.log("✅ Test token created:", mint.toString());

    // Step 5: Create fee recipient token account
    const feeRecipientTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      feeRecipient.publicKey
    );

    console.log("✅ Fee recipient token account:", feeRecipientTokenAccount.toString());

    // Step 6: Create example market
    console.log("📊 Creating example market...");
    const marketId = new anchor.BN(1);
    const question = "Will Bitcoin reach $100,000 by end of 2024?";
    const outcomes = ["Yes", "No"];
    const endTime = new anchor.BN(Math.floor(Date.now() / 1000) + 86400); // 24 hours from now
    const oracle = Keypair.generate();
    const minBet = new anchor.BN(1000000); // 1 token

    const [market] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [marketVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("market_vault"), market.toBuffer()],
      program.programId
    );

    const createMarketSignature = await program.methods
      .createMarket(marketId, question, outcomes, endTime, oracle.publicKey, minBet)
      .accounts({
        market,
        marketVault,
        globalState,
        mint,
        creator: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("✅ Example market created successfully");
    console.log("📄 Transaction signature:", createMarketSignature);

    // Step 7: Display deployment summary
    console.log("\n" + "=".repeat(60));
    console.log("🎉 DEPLOYMENT COMPLETE!");
    console.log("=".repeat(60));
    console.log("📍 Program ID:", program.programId.toString());
    console.log("🌍 Global State:", globalState.toString());
    console.log("💰 Fee Recipient:", feeRecipient.publicKey.toString());
    console.log("🪙 Test Token:", mint.toString());
    console.log("📊 Example Market:", market.toString());
    console.log("🏦 Market Vault:", marketVault.toString());
    console.log("🔮 Oracle:", oracle.publicKey.toString());
    console.log("💱 Platform Fee:", platformFeeBps / 100, "%");
    console.log("💸 Minimum Bet:", minBet.toString(), "tokens");
    console.log("=".repeat(60));

    // Step 8: Save deployment info
    const deploymentInfo = {
      network: provider.connection.rpcEndpoint,
      programId: program.programId.toString(),
      globalState: globalState.toString(),
      authority: provider.wallet.publicKey.toString(),
      feeRecipient: feeRecipient.publicKey.toString(),
      feeRecipientTokenAccount: feeRecipientTokenAccount.toString(),
      testToken: mint.toString(),
      platformFeeBps,
      exampleMarket: {
        id: marketId.toString(),
        address: market.toString(),
        vault: marketVault.toString(),
        oracle: oracle.publicKey.toString(),
        question,
        outcomes,
        endTime: endTime.toString(),
        minBet: minBet.toString(),
      },
      deployedAt: new Date().toISOString(),
    };

    // Save to file
    const fs = require('fs');
    fs.writeFileSync(
      'deployment-info.json',
      JSON.stringify(deploymentInfo, null, 2)
    );

    console.log("💾 Deployment info saved to deployment-info.json");

    // Step 9: Provide next steps
    console.log("\n📝 NEXT STEPS:");
    console.log("1. Fund user accounts with test tokens");
    console.log("2. Place bets on the example market");
    console.log("3. Wait for market expiration");
    console.log("4. Resolve market with oracle");
    console.log("5. Claim winnings");
    console.log("6. Collect platform fees");
    console.log("\n📚 Run 'anchor test' to see full functionality");
    console.log("📖 Check the README.md for usage examples");

  } catch (error) {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  }
}

// Run deployment
deploy().catch(console.error); 