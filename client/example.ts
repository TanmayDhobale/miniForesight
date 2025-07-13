import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PredictionMarket } from "../target/types/prediction_market";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

/**
 * Example client for interacting with the Prediction Market smart contract
 */
export class PredictionMarketClient {
  private program: Program<PredictionMarket>;
  private provider: anchor.AnchorProvider;
  private globalState: PublicKey;

  constructor(program: Program<PredictionMarket>, provider: anchor.AnchorProvider) {
    this.program = program;
    this.provider = provider;
    
    // Derive global state PDA
    [this.globalState] = PublicKey.findProgramAddressSync(
      [Buffer.from("global_state")],
      program.programId
    );
  }

  /**
   * Initialize the prediction market platform
   */
  async initializePlatform(
    authority: PublicKey,
    platformFeeBps: number,
    feeRecipient: PublicKey
  ): Promise<string> {
    try {
      const signature = await this.program.methods
        .initialize(platformFeeBps, feeRecipient)
        .accounts({
          globalState: this.globalState,
          authority,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("✅ Platform initialized successfully");
      console.log(`Transaction signature: ${signature}`);
      return signature;
    } catch (error) {
      console.error("❌ Failed to initialize platform:", error);
      throw error;
    }
  }

  /**
   * Create a new prediction market
   */
  async createMarket(
    marketId: anchor.BN,
    question: string,
    outcomes: string[],
    endTime: anchor.BN,
    oracle: PublicKey,
    minBet: anchor.BN,
    mint: PublicKey,
    creator: PublicKey
  ): Promise<{ signature: string; market: PublicKey; marketVault: PublicKey }> {
    try {
      // Derive market PDA
      const [market] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8)],
        this.program.programId
      );

      // Derive market vault PDA
      const [marketVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_vault"), market.toBuffer()],
        this.program.programId
      );

      const signature = await this.program.methods
        .createMarket(marketId, question, outcomes, endTime, oracle, minBet)
        .accounts({
          market,
          marketVault,
          globalState: this.globalState,
          mint,
          creator,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("✅ Market created successfully");
      console.log(`Market ID: ${marketId.toString()}`);
      console.log(`Question: ${question}`);
      console.log(`Outcomes: ${outcomes.join(", ")}`);
      console.log(`Transaction signature: ${signature}`);

      return { signature, market, marketVault };
    } catch (error) {
      console.error("❌ Failed to create market:", error);
      throw error;
    }
  }

  /**
   * Place a bet on a market outcome
   */
  async placeBet(
    market: PublicKey,
    outcomeIndex: number,
    amount: anchor.BN,
    user: PublicKey,
    userTokenAccount: PublicKey
  ): Promise<string> {
    try {
      // Derive user bet PDA
      const [userBet] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), user.toBuffer(), market.toBuffer()],
        this.program.programId
      );

      // Derive market vault PDA
      const [marketVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_vault"), market.toBuffer()],
        this.program.programId
      );

      const signature = await this.program.methods
        .placeBet(outcomeIndex, amount)
        .accounts({
          market,
          userBet,
          marketVault,
          userTokenAccount,
          user,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("✅ Bet placed successfully");
      console.log(`Amount: ${amount.toString()}`);
      console.log(`Outcome: ${outcomeIndex}`);
      console.log(`Transaction signature: ${signature}`);

      return signature;
    } catch (error) {
      console.error("❌ Failed to place bet:", error);
      throw error;
    }
  }

  /**
   * Resolve a market
   */
  async resolveMarket(
    market: PublicKey,
    winningOutcome: number,
    resolver: PublicKey
  ): Promise<string> {
    try {
      const signature = await this.program.methods
        .resolveMarket(winningOutcome)
        .accounts({
          market,
          globalState: this.globalState,
          resolver,
        })
        .rpc();

      console.log("✅ Market resolved successfully");
      console.log(`Winning outcome: ${winningOutcome}`);
      console.log(`Transaction signature: ${signature}`);

      return signature;
    } catch (error) {
      console.error("❌ Failed to resolve market:", error);
      throw error;
    }
  }

  /**
   * Claim winnings from a resolved market
   */
  async claimWinnings(
    market: PublicKey,
    user: PublicKey,
    userTokenAccount: PublicKey
  ): Promise<string> {
    try {
      // Derive user bet PDA
      const [userBet] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), user.toBuffer(), market.toBuffer()],
        this.program.programId
      );

      // Derive market vault PDA
      const [marketVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_vault"), market.toBuffer()],
        this.program.programId
      );

      const signature = await this.program.methods
        .claimWinnings()
        .accounts({
          market,
          userBet,
          marketVault,
          userTokenAccount,
          globalState: this.globalState,
          user,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log("✅ Winnings claimed successfully");
      console.log(`Transaction signature: ${signature}`);

      return signature;
    } catch (error) {
      console.error("❌ Failed to claim winnings:", error);
      throw error;
    }
  }

  /**
   * Collect platform fees
   */
  async collectFees(
    market: PublicKey,
    authority: PublicKey,
    feeRecipientTokenAccount: PublicKey
  ): Promise<string> {
    try {
      // Derive market vault PDA
      const [marketVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_vault"), market.toBuffer()],
        this.program.programId
      );

      const signature = await this.program.methods
        .collectFees()
        .accounts({
          market,
          marketVault,
          feeRecipientTokenAccount,
          globalState: this.globalState,
          authority,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log("✅ Fees collected successfully");
      console.log(`Transaction signature: ${signature}`);

      return signature;
    } catch (error) {
      console.error("❌ Failed to collect fees:", error);
      throw error;
    }
  }

  /**
   * Get market information
   */
  async getMarket(market: PublicKey): Promise<any> {
    try {
      const marketAccount = await this.program.account.market.fetch(market);
      return marketAccount;
    } catch (error) {
      console.error("❌ Failed to fetch market:", error);
      throw error;
    }
  }

  /**
   * Get user bet information
   */
  async getUserBet(user: PublicKey, market: PublicKey): Promise<any> {
    try {
      const [userBet] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), user.toBuffer(), market.toBuffer()],
        this.program.programId
      );

      const userBetAccount = await this.program.account.userBet.fetch(userBet);
      return userBetAccount;
    } catch (error) {
      console.error("❌ Failed to fetch user bet:", error);
      throw error;
    }
  }

  /**
   * Get global state information
   */
  async getGlobalState(): Promise<any> {
    try {
      const globalStateAccount = await this.program.account.globalState.fetch(this.globalState);
      return globalStateAccount;
    } catch (error) {
      console.error("❌ Failed to fetch global state:", error);
      throw error;
    }
  }
}

/**
 * Example usage of the PredictionMarketClient
 */
async function example() {
  // Set up provider and program
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PredictionMarket as Program<PredictionMarket>;
  
  // Create client instance
  const client = new PredictionMarketClient(program, provider);
  
  // Example: Create a simple Bitcoin prediction market
  try {
    const authority = provider.wallet.publicKey;
    const feeRecipient = Keypair.generate().publicKey;
    
    // Initialize platform
    await client.initializePlatform(authority, 250, feeRecipient); // 2.5% fee
    
    // Create mint for testing
    const mint = await createMint(
      provider.connection,
      provider.wallet.payer,
      authority,
      authority,
      6
    );
    
    // Create market
    const marketId = new anchor.BN(1);
    const question = "Will Bitcoin reach $100,000 by end of 2024?";
    const outcomes = ["Yes", "No"];
    const endTime = new anchor.BN(Date.now() / 1000 + 86400); // 24 hours from now
    const oracle = Keypair.generate().publicKey;
    const minBet = new anchor.BN(1000000); // 1 token
    
    const { market } = await client.createMarket(
      marketId,
      question,
      outcomes,
      endTime,
      oracle,
      minBet,
      mint,
      authority
    );
    
    // Get market info
    const marketInfo = await client.getMarket(market);
    console.log("Market Info:", marketInfo);
    
    // Get global state
    const globalState = await client.getGlobalState();
    console.log("Global State:", globalState);
    
  } catch (error) {
    console.error("Example failed:", error);
  }
}

// Run example if this file is executed directly
if (require.main === module) {
  example().catch(console.error);
} 