# Prediction Market Smart Contract

A decentralized prediction market platform built on Solana using the Anchor framework. This contract enables users to create prediction markets, place bets on outcomes, and claim winnings based on oracle-resolved results.

## 🚀 **Production-Ready Smart Contract**

This contract is built with startup best practices - the perfect balance of:
- ✅ **Production-ready security**
- ✅ **Clean, maintainable code**  
- ✅ **Revenue model included** (platform fees)
- ✅ **Multiple outcome markets** (2-8 outcomes)
- ✅ **Oracle resolution system**
- ✅ **Emergency controls**
- ✅ **Reasonable development time** (3-4 weeks)

## 🚀 Features

### Core Functionality
- **Market Creation**: Anyone can create new prediction markets with custom questions, outcomes, and oracles
- **Betting System**: Users can place bets on any outcome with secure fund locking
- **Oracle Resolution**: Markets are resolved by designated oracles or platform authority
- **Proportional Payouts**: Winners receive payouts proportional to their stake
- **Platform Fees**: Configurable fee system for platform sustainability
- **Transparency**: All actions are logged with comprehensive events

### Security Features
- **Access Control**: Role-based permissions for market resolution and fee collection
- **Reentrancy Protection**: Secure token transfers using Anchor's CPI framework
- **Input Validation**: Comprehensive validation of all user inputs
- **Time-based Constraints**: Markets can only be resolved after expiration
- **Overflow Protection**: Built-in arithmetic overflow protection

## 🏗️ Architecture

### Account Structure

```
GlobalState
├── authority: Pubkey         // Platform authority
├── platform_fee_bps: u16   // Platform fee in basis points
├── fee_recipient: Pubkey    // Fee recipient address
├── total_markets: u64       // Total number of markets created
└── bump: u8                 // PDA bump seed

Market
├── id: u64                  // Unique market identifier
├── creator: Pubkey          // Market creator
├── question: String         // Market question (max 200 chars)
├── outcomes: Vec<String>    // Possible outcomes (2-10 options)
├── end_time: i64           // Market expiration timestamp
├── oracle: Pubkey          // Oracle responsible for resolution
├── min_bet: u64            // Minimum bet amount
├── status: MarketStatus    // Active, Resolved, or Cancelled
├── total_pool: u64         // Total amount bet on all outcomes
├── outcome_pools: Vec<u64> // Amount bet on each outcome
├── winning_outcome: Option<u8> // Winning outcome index
├── created_at: i64         // Creation timestamp
└── bump: u8                // PDA bump seed

UserBet
├── user: Pubkey             // User's public key
├── market: Pubkey           // Market reference
├── bets: Vec<u64>          // Bet amounts per outcome
├── total_bet: u64          // Total amount bet by user
├── claimed: bool           // Whether winnings have been claimed
└── bump: u8                // PDA bump seed
```

### Program Instructions

1. **initialize**: Initialize the global platform state
2. **create_market**: Create a new prediction market
3. **place_bet**: Place a bet on a specific outcome
4. **resolve_market**: Resolve a market with the winning outcome
5. **claim_winnings**: Claim winnings for resolved markets
6. **collect_fees**: Collect platform fees (authority only)
7. **close_market**: Emergency market closure (authority only)

## 🛠️ Setup & Installation

### Prerequisites
- [Rust](https://rustup.rs/) (latest stable version)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) (v1.16+)
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) (v0.31+)
- [Node.js](https://nodejs.org/) (v16+)
- [Yarn](https://yarnpkg.com/) or npm

### Installation

1. **Clone the repository**:
```bash
git clone <repository-url>
cd prediction-market
```

2. **Install dependencies**:
```bash
yarn install
# or
npm install
```

3. **Configure Solana CLI**:
```bash
solana config set --url localhost
solana-keygen new
```

4. **Start local validator**:
```bash
solana-test-validator
```

5. **Build the program**:
```bash
anchor build
```

6. **Deploy to localnet**:
```bash
anchor deploy
```

7. **Run tests**:
```bash
anchor test
```

## 📖 Usage Examples

### 1. Initialize Platform

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PredictionMarket } from "./target/types/prediction_market";

const program = anchor.workspace.PredictionMarket as Program<PredictionMarket>;
const authority = provider.wallet.publicKey;
const feeRecipient = new PublicKey("...");

const [globalState] = PublicKey.findProgramAddressSync(
  [Buffer.from("global_state")],
  program.programId
);

await program.methods
  .initialize(250, feeRecipient) // 2.5% platform fee
  .accounts({
    globalState,
    authority,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

### 2. Create Market

```typescript
const marketId = new anchor.BN(1);
const question = "Will Bitcoin reach $100,000 by end of 2024?";
const outcomes = ["Yes", "No"];
const endTime = new anchor.BN(Date.now() / 1000 + 86400); // 24 hours
const oracle = new PublicKey("...");
const minBet = new anchor.BN(1000000); // 1 token

const [market] = PublicKey.findProgramAddressSync(
  [Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8)],
  program.programId
);

const [marketVault] = PublicKey.findProgramAddressSync(
  [Buffer.from("market_vault"), market.toBuffer()],
  program.programId
);

await program.methods
  .createMarket(marketId, question, outcomes, endTime, oracle, minBet)
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
```

### 3. Place Bet

```typescript
const outcomeIndex = 0; // Betting on "Yes"
const amount = new anchor.BN(10000000); // 10 tokens

const [userBet] = PublicKey.findProgramAddressSync(
  [Buffer.from("user_bet"), user.publicKey.toBuffer(), market.toBuffer()],
  program.programId
);

await program.methods
  .placeBet(outcomeIndex, amount)
  .accounts({
    market,
    userBet,
    marketVault,
    userTokenAccount,
    user: user.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .signers([user])
  .rpc();
```

### 4. Resolve Market

```typescript
const winningOutcome = 0; // "Yes" wins

await program.methods
  .resolveMarket(winningOutcome)
  .accounts({
    market,
    globalState,
    resolver: oracle.publicKey,
  })
  .signers([oracle])
  .rpc();
```

### 5. Claim Winnings

```typescript
await program.methods
  .claimWinnings()
  .accounts({
    market,
    userBet,
    marketVault,
    userTokenAccount,
    globalState,
    user: user.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([user])
  .rpc();
```

## 🔐 Security Considerations

### Access Control
- **Market Resolution**: Only designated oracles or platform authority can resolve markets
- **Fee Collection**: Only platform authority can collect fees
- **Emergency Closure**: Only platform authority can close markets

### Validation
- Markets must have 2-10 outcomes
- Market end time must be in the future
- Bets must meet minimum amount requirements
- Markets can only be resolved after expiration
- Users can only claim winnings once

### Financial Security
- Funds are locked in PDAs until market resolution
- Platform fees are calculated and reserved during payout
- No funds can be withdrawn until market resolution
- Proportional payout system prevents manipulation

## 🧪 Testing

The contract includes comprehensive tests covering:

- Platform initialization
- Market creation with various parameters
- Betting with multiple users and outcomes
- Market resolution by oracles
- Winnings calculation and claiming
- Fee collection
- Error handling and edge cases
- Access control validation

Run tests with:
```bash
anchor test
```

## 📊 Events

The contract emits the following events for transparency:

- **PlatformInitialized**: Platform setup completed
- **MarketCreated**: New market created
- **BetPlaced**: Bet placed by user
- **MarketResolved**: Market resolved with winning outcome
- **WinningsClaimed**: User claimed winnings
- **FeesCollected**: Platform fees collected
- **MarketClosed**: Market closed by authority

## 🔄 Upgrade Path

The contract is designed to be upgradeable through Solana's upgrade mechanism:

1. Deploy new program version
2. Update program ID in client applications
3. Migrate state if necessary
4. Update Anchor.toml configuration

## 📝 Error Codes

Common error codes and their meanings:

- `InsufficientOutcomes`: Market needs at least 2 outcomes
- `TooManyOutcomes`: Market cannot have more than 10 outcomes
- `InvalidEndTime`: End time must be in the future
- `MarketNotActive`: Market is not in active state
- `MarketExpired`: Cannot bet on expired market
- `BetTooSmall`: Bet amount below minimum
- `UnauthorizedResolver`: Only oracle/authority can resolve
- `MarketNotResolved`: Market must be resolved before claiming
- `AlreadyClaimed`: User has already claimed winnings
- `NoWinningBet`: User has no winning bet to claim

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License. See the LICENSE file for details.

## 🆘 Support

For questions and support:
- Create an issue in the GitHub repository
- Review the test files for usage examples
- Check the Anchor documentation for framework details

## 🚨 Disclaimer

This smart contract is for educational and development purposes. Ensure proper auditing and testing before deploying to mainnet with real funds. 