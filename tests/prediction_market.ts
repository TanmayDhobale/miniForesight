import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PredictionMarket } from "../target/types/prediction_market";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("prediction_market", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PredictionMarket as Program<PredictionMarket>;
  const authority = provider.wallet.publicKey;
  
  let mint: PublicKey;
  let globalState: PublicKey;
  let feeRecipient: PublicKey;
  let feeRecipientTokenAccount: PublicKey;
  
  // Test users
  let user1: anchor.web3.Keypair;
  let user2: anchor.web3.Keypair;
  let user1TokenAccount: PublicKey;
  let user2TokenAccount: PublicKey;
  
  // Oracle
  let oracle: anchor.web3.Keypair;
  
  // Market variables
  let marketId = new anchor.BN(1);
  let market: PublicKey;
  let marketVault: PublicKey;
  
  const PLATFORM_FEE_BPS = 250; // 2.5%
  const MIN_BET = new anchor.BN(1000000); // 1 token (6 decimals)
  
  before(async () => {
    // Create mint
    mint = await createMint(
      provider.connection,
      provider.wallet.payer,
      authority,
      authority,
      6 // 6 decimals
    );
    
    // Create test users
    user1 = anchor.web3.Keypair.generate();
    user2 = anchor.web3.Keypair.generate();
    oracle = anchor.web3.Keypair.generate();
    
    // Airdrop SOL to users
    await provider.connection.requestAirdrop(user1.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(user2.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(oracle.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL);
    
    // Create fee recipient
    feeRecipient = anchor.web3.Keypair.generate().publicKey;
    feeRecipientTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      feeRecipient
    );
    
    // Create user token accounts
    user1TokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      user1.publicKey
    );
    
    user2TokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      user2.publicKey
    );
    
    // Mint tokens to users
    await mintTo(
      provider.connection,
      provider.wallet.payer,
      mint,
      user1TokenAccount,
      authority,
      100_000_000_000 // 100,000 tokens
    );
    
    await mintTo(
      provider.connection,
      provider.wallet.payer,
      mint,
      user2TokenAccount,
      authority,
      100_000_000_000 // 100,000 tokens
    );
    
    // Derive PDAs
    [globalState] = PublicKey.findProgramAddressSync(
      [Buffer.from("global_state")],
      program.programId
    );
    
    [market] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    
    [marketVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("market_vault"), market.toBuffer()],
      program.programId
    );
  });
  
  describe("Platform Initialization", () => {
    it("Initializes the platform successfully", async () => {
      try {
        await program.methods
          .initialize(PLATFORM_FEE_BPS, feeRecipient)
          .accounts({
            globalState,
            authority,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
          
        const globalStateAccount = await program.account.globalState.fetch(globalState);
        expect(globalStateAccount.authority.toString()).to.equal(authority.toString());
        expect(globalStateAccount.platformFeeBps).to.equal(PLATFORM_FEE_BPS);
        expect(globalStateAccount.feeRecipient.toString()).to.equal(feeRecipient.toString());
        expect(globalStateAccount.totalMarkets.toNumber()).to.equal(0);
      } catch (error) {
        console.error("Error during initialization:", error);
        throw error;
      }
    });
    
    it("Fails to initialize twice", async () => {
      try {
        await program.methods
          .initialize(PLATFORM_FEE_BPS, feeRecipient)
          .accounts({
            globalState,
            authority,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("already in use");
      }
    });
  });
  
  describe("Market Creation", () => {
    it("Creates a market successfully", async () => {
      const question = "Will Bitcoin reach $100,000 by end of 2024?";
      const outcomes = ["Yes", "No"];
      const endTime = new anchor.BN(Date.now() / 1000 + 86400); // 24 hours from now
      
      try {
        await program.methods
          .createMarket(
            marketId,
            question,
            outcomes,
            endTime,
            oracle.publicKey,
            MIN_BET
          )
          .accounts({
            market,
            marketVault,
            globalState,
            mint,
            creator: authority,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
          
        const marketAccount = await program.account.market.fetch(market);
        expect(marketAccount.id.toNumber()).to.equal(marketId.toNumber());
        expect(marketAccount.creator.toString()).to.equal(authority.toString());
        expect(marketAccount.question).to.equal(question);
        expect(marketAccount.outcomes).to.deep.equal(outcomes);
        expect(marketAccount.oracle.toString()).to.equal(oracle.publicKey.toString());
        expect(marketAccount.minBet.toNumber()).to.equal(MIN_BET.toNumber());
        expect(marketAccount.status).to.deep.equal({ active: {} });
        expect(marketAccount.totalPool.toNumber()).to.equal(0);
        expect(marketAccount.outcomePoolsVectorSize).to.equal(outcomes.length);
        expect(marketAccount.winningOutcome).to.equal(null);
        
        // Check global state updated
        const globalStateAccount = await program.account.globalState.fetch(globalState);
        expect(globalStateAccount.totalMarkets.toNumber()).to.equal(1);
      } catch (error) {
        console.error("Error during market creation:", error);
        throw error;
      }
    });
    
    it("Fails to create market with insufficient outcomes", async () => {
      const question = "Invalid market?";
      const outcomes = ["Only one outcome"];
      const endTime = new anchor.BN(Date.now() / 1000 + 86400);
      const newMarketId = new anchor.BN(2);
      
      const [newMarket] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), newMarketId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      
      const [newMarketVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_vault"), newMarket.toBuffer()],
        program.programId
      );
      
      try {
        await program.methods
          .createMarket(
            newMarketId,
            question,
            outcomes,
            endTime,
            oracle.publicKey,
            MIN_BET
          )
          .accounts({
            market: newMarket,
            marketVault: newMarketVault,
            globalState,
            mint,
            creator: authority,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
          
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("InsufficientOutcomes");
      }
    });
    
    it("Fails to create market with past end time", async () => {
      const question = "Past market?";
      const outcomes = ["Yes", "No"];
      const endTime = new anchor.BN(Date.now() / 1000 - 86400); // 24 hours ago
      const newMarketId = new anchor.BN(3);
      
      const [newMarket] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), newMarketId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      
      const [newMarketVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_vault"), newMarket.toBuffer()],
        program.programId
      );
      
      try {
        await program.methods
          .createMarket(
            newMarketId,
            question,
            outcomes,
            endTime,
            oracle.publicKey,
            MIN_BET
          )
          .accounts({
            market: newMarket,
            marketVault: newMarketVault,
            globalState,
            mint,
            creator: authority,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
          
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("InvalidEndTime");
      }
    });
  });
  
  describe("Betting", () => {
    let user1Bet: PublicKey;
    let user2Bet: PublicKey;
    
    before(async () => {
      [user1Bet] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), user1.publicKey.toBuffer(), market.toBuffer()],
        program.programId
      );
      
      [user2Bet] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), user2.publicKey.toBuffer(), market.toBuffer()],
        program.programId
      );
    });
    
    it("Places a bet successfully", async () => {
      const betAmount = new anchor.BN(10_000_000); // 10 tokens
      const outcomeIndex = 0; // "Yes"
      
      try {
        await program.methods
          .placeBet(outcomeIndex, betAmount)
          .accounts({
            market,
            userBet: user1Bet,
            marketVault,
            userTokenAccount: user1TokenAccount,
            user: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
          
        const marketAccount = await program.account.market.fetch(market);
        expect(marketAccount.totalPool.toNumber()).to.equal(betAmount.toNumber());
        expect(marketAccount.outcomePools[outcomeIndex].toNumber()).to.equal(betAmount.toNumber());
        
        const userBetAccount = await program.account.userBet.fetch(user1Bet);
        expect(userBetAccount.user.toString()).to.equal(user1.publicKey.toString());
        expect(userBetAccount.market.toString()).to.equal(market.toString());
        expect(userBetAccount.bets[outcomeIndex].toNumber()).to.equal(betAmount.toNumber());
        expect(userBetAccount.totalBet.toNumber()).to.equal(betAmount.toNumber());
        expect(userBetAccount.claimed).to.equal(false);
      } catch (error) {
        console.error("Error during betting:", error);
        throw error;
      }
    });
    
    it("Places multiple bets from different users", async () => {
      const betAmount = new anchor.BN(20_000_000); // 20 tokens
      const outcomeIndex = 1; // "No"
      
      try {
        await program.methods
          .placeBet(outcomeIndex, betAmount)
          .accounts({
            market,
            userBet: user2Bet,
            marketVault,
            userTokenAccount: user2TokenAccount,
            user: user2.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user2])
          .rpc();
          
        const marketAccount = await program.account.market.fetch(market);
        expect(marketAccount.totalPool.toNumber()).to.equal(30_000_000); // 10 + 20
        expect(marketAccount.outcomePools[0].toNumber()).to.equal(10_000_000); // "Yes"
        expect(marketAccount.outcomePools[1].toNumber()).to.equal(20_000_000); // "No"
      } catch (error) {
        console.error("Error during betting:", error);
        throw error;
      }
    });
    
    it("Places additional bet on same outcome", async () => {
      const betAmount = new anchor.BN(5_000_000); // 5 tokens
      const outcomeIndex = 0; // "Yes"
      
      try {
        await program.methods
          .placeBet(outcomeIndex, betAmount)
          .accounts({
            market,
            userBet: user1Bet,
            marketVault,
            userTokenAccount: user1TokenAccount,
            user: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
          
        const marketAccount = await program.account.market.fetch(market);
        expect(marketAccount.totalPool.toNumber()).to.equal(35_000_000); // 10 + 20 + 5
        expect(marketAccount.outcomePools[0].toNumber()).to.equal(15_000_000); // "Yes": 10 + 5
        expect(marketAccount.outcomePools[1].toNumber()).to.equal(20_000_000); // "No": 20
        
        const userBetAccount = await program.account.userBet.fetch(user1Bet);
        expect(userBetAccount.bets[0].toNumber()).to.equal(15_000_000); // 10 + 5
        expect(userBetAccount.totalBet.toNumber()).to.equal(15_000_000);
      } catch (error) {
        console.error("Error during betting:", error);
        throw error;
      }
    });
    
    it("Fails to bet with insufficient amount", async () => {
      const betAmount = new anchor.BN(500_000); // 0.5 tokens (below minimum)
      const outcomeIndex = 0;
      
      try {
        await program.methods
          .placeBet(outcomeIndex, betAmount)
          .accounts({
            market,
            userBet: user1Bet,
            marketVault,
            userTokenAccount: user1TokenAccount,
            user: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
          
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("BetTooSmall");
      }
    });
    
    it("Fails to bet on invalid outcome", async () => {
      const betAmount = new anchor.BN(1_000_000);
      const outcomeIndex = 5; // Invalid outcome index
      
      try {
        await program.methods
          .placeBet(outcomeIndex, betAmount)
          .accounts({
            market,
            userBet: user1Bet,
            marketVault,
            userTokenAccount: user1TokenAccount,
            user: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
          
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("InvalidOutcome");
      }
    });
  });
  
  describe("Market Resolution", () => {
    it("Resolves market successfully by oracle", async () => {
      const winningOutcome = 0; // "Yes" wins
      
      // First, we need to wait for the market to expire
      // For testing purposes, we'll create a new market with a past end time
      const newMarketId = new anchor.BN(4);
      const [testMarket] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), newMarketId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      
      const [testMarketVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_vault"), testMarket.toBuffer()],
        program.programId
      );
      
      // Create a market that expires immediately
      const endTime = new anchor.BN(Math.floor(Date.now() / 1000) - 1);
      
      await program.methods
        .createMarket(
          newMarketId,
          "Test resolution market",
          ["Yes", "No"],
          endTime,
          oracle.publicKey,
          MIN_BET
        )
        .accounts({
          market: testMarket,
          marketVault: testMarketVault,
          globalState,
          mint,
          creator: authority,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      
      // Add some bets
      const [testUser1Bet] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), user1.publicKey.toBuffer(), testMarket.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeBet(0, new anchor.BN(10_000_000))
        .accounts({
          market: testMarket,
          userBet: testUser1Bet,
          marketVault: testMarketVault,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();
      
      // Now resolve the market
      try {
        await program.methods
          .resolveMarket(winningOutcome)
          .accounts({
            market: testMarket,
            globalState,
            resolver: oracle.publicKey,
          })
          .signers([oracle])
          .rpc();
          
        const marketAccount = await program.account.market.fetch(testMarket);
        expect(marketAccount.status).to.deep.equal({ resolved: {} });
        expect(marketAccount.winningOutcome).to.equal(winningOutcome);
      } catch (error) {
        console.error("Error during market resolution:", error);
        throw error;
      }
    });
    
    it("Fails to resolve market before expiry", async () => {
      const winningOutcome = 0;
      
      try {
        await program.methods
          .resolveMarket(winningOutcome)
          .accounts({
            market,
            globalState,
            resolver: oracle.publicKey,
          })
          .signers([oracle])
          .rpc();
          
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("MarketNotExpired");
      }
    });
    
    it("Fails to resolve market with unauthorized user", async () => {
      const winningOutcome = 0;
      const unauthorizedUser = anchor.web3.Keypair.generate();
      
      try {
        await program.methods
          .resolveMarket(winningOutcome)
          .accounts({
            market,
            globalState,
            resolver: unauthorizedUser.publicKey,
          })
          .signers([unauthorizedUser])
          .rpc();
          
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("UnauthorizedResolver");
      }
    });
  });
  
  describe("Winnings and Fees", () => {
    let resolvedMarket: PublicKey;
    let resolvedMarketVault: PublicKey;
    let resolvedUser1Bet: PublicKey;
    let resolvedUser2Bet: PublicKey;
    
    before(async () => {
      // Create a new market for testing winnings
      const newMarketId = new anchor.BN(5);
      [resolvedMarket] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), newMarketId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      
      [resolvedMarketVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_vault"), resolvedMarket.toBuffer()],
        program.programId
      );
      
      [resolvedUser1Bet] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), user1.publicKey.toBuffer(), resolvedMarket.toBuffer()],
        program.programId
      );
      
      [resolvedUser2Bet] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), user2.publicKey.toBuffer(), resolvedMarket.toBuffer()],
        program.programId
      );
      
      // Create market that expires immediately
      const endTime = new anchor.BN(Math.floor(Date.now() / 1000) - 1);
      
      await program.methods
        .createMarket(
          newMarketId,
          "Winnings test market",
          ["Yes", "No"],
          endTime,
          oracle.publicKey,
          MIN_BET
        )
        .accounts({
          market: resolvedMarket,
          marketVault: resolvedMarketVault,
          globalState,
          mint,
          creator: authority,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      
      // User1 bets on "Yes" (outcome 0)
      await program.methods
        .placeBet(0, new anchor.BN(10_000_000))
        .accounts({
          market: resolvedMarket,
          userBet: resolvedUser1Bet,
          marketVault: resolvedMarketVault,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();
      
      // User2 bets on "No" (outcome 1)
      await program.methods
        .placeBet(1, new anchor.BN(40_000_000))
        .accounts({
          market: resolvedMarket,
          userBet: resolvedUser2Bet,
          marketVault: resolvedMarketVault,
          userTokenAccount: user2TokenAccount,
          user: user2.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();
      
      // Resolve market with "Yes" (outcome 0) as winner
      await program.methods
        .resolveMarket(0)
        .accounts({
          market: resolvedMarket,
          globalState,
          resolver: oracle.publicKey,
        })
        .signers([oracle])
        .rpc();
    });
    
    it("Claims winnings successfully", async () => {
      const initialBalance = await provider.connection.getTokenAccountBalance(user1TokenAccount);
      
      try {
        await program.methods
          .claimWinnings()
          .accounts({
            market: resolvedMarket,
            userBet: resolvedUser1Bet,
            marketVault: resolvedMarketVault,
            userTokenAccount: user1TokenAccount,
            globalState,
            user: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
          
        const finalBalance = await provider.connection.getTokenAccountBalance(user1TokenAccount);
        const userBetAccount = await program.account.userBet.fetch(resolvedUser1Bet);
        
        expect(userBetAccount.claimed).to.equal(true);
        expect(parseInt(finalBalance.value.amount)).to.be.greaterThan(parseInt(initialBalance.value.amount));
      } catch (error) {
        console.error("Error during winnings claim:", error);
        throw error;
      }
    });
    
    it("Fails to claim winnings twice", async () => {
      try {
        await program.methods
          .claimWinnings()
          .accounts({
            market: resolvedMarket,
            userBet: resolvedUser1Bet,
            marketVault: resolvedMarketVault,
            userTokenAccount: user1TokenAccount,
            globalState,
            user: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
          
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("AlreadyClaimed");
      }
    });
    
    it("Fails to claim winnings for losing bet", async () => {
      try {
        await program.methods
          .claimWinnings()
          .accounts({
            market: resolvedMarket,
            userBet: resolvedUser2Bet,
            marketVault: resolvedMarketVault,
            userTokenAccount: user2TokenAccount,
            globalState,
            user: user2.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user2])
          .rpc();
          
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("NoWinningBet");
      }
    });
    
    it("Collects platform fees successfully", async () => {
      const initialBalance = await provider.connection.getTokenAccountBalance(feeRecipientTokenAccount);
      
      try {
        await program.methods
          .collectFees()
          .accounts({
            market: resolvedMarket,
            marketVault: resolvedMarketVault,
            feeRecipientTokenAccount,
            globalState,
            authority,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
          
        const finalBalance = await provider.connection.getTokenAccountBalance(feeRecipientTokenAccount);
        expect(parseInt(finalBalance.value.amount)).to.be.greaterThan(parseInt(initialBalance.value.amount));
      } catch (error) {
        console.error("Error during fee collection:", error);
        throw error;
      }
    });
  });
  
  describe("Emergency Functions", () => {
    it("Closes market successfully by authority", async () => {
      try {
        await program.methods
          .closeMarket()
          .accounts({
            market,
            globalState,
            authority,
          })
          .rpc();
          
        const marketAccount = await program.account.market.fetch(market);
        expect(marketAccount.status).to.deep.equal({ cancelled: {} });
      } catch (error) {
        console.error("Error during market closure:", error);
        throw error;
      }
    });
    
    it("Fails to close market with unauthorized user", async () => {
      const unauthorizedUser = anchor.web3.Keypair.generate();
      
      try {
        await program.methods
          .closeMarket()
          .accounts({
            market,
            globalState,
            authority: unauthorizedUser.publicKey,
          })
          .signers([unauthorizedUser])
          .rpc();
          
        expect.fail("Should have failed");
      } catch (error) {
        expect(error.message).to.include("UnauthorizedMarketClose");
      }
    });
  });
}); 