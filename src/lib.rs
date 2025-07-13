use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, Mint};

declare_id!("11111111111111111111111111111112");

// Practical constants - not over-engineered
const MAX_OUTCOMES: usize = 8;           // Reasonable limit
const MAX_QUESTION_LEN: usize = 200;     // Twitter-like limit
const MAX_OUTCOME_LEN: usize = 50;       // Short and clear
const MAX_FEE_BPS: u16 = 500;           // 5% max fee (reasonable)
const MIN_DURATION: i64 = 3600;         // 1 hour minimum
const MAX_DURATION: i64 = 7776000;      // 90 days maximum

#[program]
pub mod prediction_market {
    use super::*;

    /// Initialize platform - clean and simple
    pub fn initialize(
        ctx: Context<Initialize>,
        fee_bps: u16,
        fee_recipient: Pubkey,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, ErrorCode::FeeTooHigh);
        
        let state = &mut ctx.accounts.global_state;
        state.authority = ctx.accounts.authority.key();
        state.fee_bps = fee_bps;
        state.fee_recipient = fee_recipient;
        state.total_markets = 0;
        state.bump = ctx.bumps.global_state;

        emit!(PlatformInitialized {
            authority: state.authority,
            fee_bps,
        });

        Ok(())
    }

    /// Create market - flexible but validated
    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: u64,
        question: String,
        outcomes: Vec<String>,
        end_time: i64,
        oracle: Pubkey,
        min_bet: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        
        // Smart validation - not excessive
        require!(outcomes.len() >= 2 && outcomes.len() <= MAX_OUTCOMES, ErrorCode::InvalidOutcomes);
        require!(end_time > now && end_time - now >= MIN_DURATION, ErrorCode::InvalidEndTime);
        require!(end_time - now <= MAX_DURATION, ErrorCode::EndTimeTooFar);
        require!(!question.trim().is_empty() && question.len() <= MAX_QUESTION_LEN, ErrorCode::InvalidQuestion);
        require!(min_bet > 0, ErrorCode::InvalidMinBet);

        // Validate outcomes - practical checks
        for outcome in &outcomes {
            require!(!outcome.trim().is_empty() && outcome.len() <= MAX_OUTCOME_LEN, ErrorCode::InvalidOutcome);
        }

        let market = &mut ctx.accounts.market;
        market.id = market_id;
        market.creator = ctx.accounts.creator.key();
        market.question = question.clone();
        market.outcomes = outcomes.clone();
        market.end_time = end_time;
        market.oracle = oracle;
        market.min_bet = min_bet;
        market.total_pool = 0;
        market.outcome_pools = vec![0; outcomes.len()];
        market.resolved = false;
        market.winner = None;
        market.created_at = now;
        market.bump = ctx.bumps.market;

        // Update global counter
        ctx.accounts.global_state.total_markets += 1;

        emit!(MarketCreated {
            market_id,
            question,
            outcomes,
            end_time,
            oracle,
        });

        Ok(())
    }

    /// Place bet - secure and efficient
    pub fn place_bet(
        ctx: Context<PlaceBet>,
        outcome_index: u8,
        amount: u64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let now = Clock::get()?.unix_timestamp;

        // Essential validations
        require!(!market.resolved, ErrorCode::MarketResolved);
        require!(now < market.end_time, ErrorCode::MarketExpired);
        require!(outcome_index < market.outcomes.len() as u8, ErrorCode::InvalidOutcome);
        require!(amount >= market.min_bet, ErrorCode::BetTooSmall);

        // Safe arithmetic
        market.total_pool = market.total_pool.checked_add(amount).ok_or(ErrorCode::Overflow)?;
        market.outcome_pools[outcome_index as usize] = 
            market.outcome_pools[outcome_index as usize].checked_add(amount).ok_or(ErrorCode::Overflow)?;

        // Transfer tokens
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                }
            ),
            amount
        )?;

        // Update user bet
        let user_bet = &mut ctx.accounts.user_bet;
        if user_bet.user == Pubkey::default() {
            user_bet.user = ctx.accounts.user.key();
            user_bet.market = market.key();
            user_bet.bets = vec![0; market.outcomes.len()];
            user_bet.total_bet = 0;
            user_bet.claimed = false;
            user_bet.bump = ctx.bumps.user_bet;
        }

        user_bet.bets[outcome_index as usize] = 
            user_bet.bets[outcome_index as usize].checked_add(amount).ok_or(ErrorCode::Overflow)?;
        user_bet.total_bet = user_bet.total_bet.checked_add(amount).ok_or(ErrorCode::Overflow)?;

        emit!(BetPlaced {
            user: ctx.accounts.user.key(),
            market_id: market.id,
            outcome_index,
            amount,
        });

        Ok(())
    }

    /// Resolve market - oracle or authority
    pub fn resolve_market(
        ctx: Context<ResolveMarket>,
        winning_outcome: u8,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let now = Clock::get()?.unix_timestamp;

        // Authority check
        require!(
            ctx.accounts.resolver.key() == market.oracle || 
            ctx.accounts.resolver.key() == ctx.accounts.global_state.authority,
            ErrorCode::Unauthorized
        );

        // State validations
        require!(!market.resolved, ErrorCode::AlreadyResolved);
        require!(now >= market.end_time, ErrorCode::TooEarly);
        require!(winning_outcome < market.outcomes.len() as u8, ErrorCode::InvalidOutcome);
        require!(market.outcome_pools[winning_outcome as usize] > 0, ErrorCode::NoWinners);

        market.resolved = true;
        market.winner = Some(winning_outcome);

        emit!(MarketResolved {
            market_id: market.id,
            winner: winning_outcome,
        });

        Ok(())
    }

    /// Claim winnings - proportional payout with fees
    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        let market = &ctx.accounts.market;
        let user_bet = &mut ctx.accounts.user_bet;
        let global_state = &ctx.accounts.global_state;

        require!(market.resolved, ErrorCode::NotResolved);
        require!(!user_bet.claimed, ErrorCode::AlreadyClaimed);
        require!(user_bet.user == ctx.accounts.user.key(), ErrorCode::Unauthorized);

        let winner = market.winner.unwrap();
        let user_winning_bet = user_bet.bets[winner as usize];
        require!(user_winning_bet > 0, ErrorCode::NoWinningBet);

        // Calculate payout - clean math
        let total_pool = market.total_pool;
        let winning_pool = market.outcome_pools[winner as usize];
        let platform_fee = total_pool * global_state.fee_bps as u64 / 10000;
        let prize_pool = total_pool - platform_fee;
        let user_winnings = user_winning_bet * prize_pool / winning_pool;

        require!(user_winnings >= user_winning_bet, ErrorCode::InvalidPayout);

        // Transfer winnings
        let seeds = &[
            b"vault",
            market.key().as_ref(),
            &[ctx.bumps.market_vault],
        ];
        
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.market_vault.to_account_info(),
                },
                &[&seeds[..]]
            ),
            user_winnings
        )?;

        user_bet.claimed = true;

        emit!(WinningsClaimed {
            user: ctx.accounts.user.key(),
            market_id: market.id,
            amount: user_winnings,
        });

        Ok(())
    }

    /// Collect platform fees
    pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
        let market = &ctx.accounts.market;
        let global_state = &ctx.accounts.global_state;

        require!(ctx.accounts.authority.key() == global_state.authority, ErrorCode::Unauthorized);
        require!(market.resolved, ErrorCode::NotResolved);

        let platform_fee = market.total_pool * global_state.fee_bps as u64 / 10000;
        
        if platform_fee > 0 {
            let seeds = &[
                b"vault",
                market.key().as_ref(),
                &[ctx.bumps.market_vault],
            ];
            
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.market_vault.to_account_info(),
                        to: ctx.accounts.fee_token_account.to_account_info(),
                        authority: ctx.accounts.market_vault.to_account_info(),
                    },
                    &[&seeds[..]]
                ),
                platform_fee
            )?;

            emit!(FeesCollected {
                market_id: market.id,
                amount: platform_fee,
            });
        }

        Ok(())
    }

    /// Emergency close market
    pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        
        require!(
            ctx.accounts.authority.key() == ctx.accounts.global_state.authority,
            ErrorCode::Unauthorized
        );
        require!(!market.resolved, ErrorCode::AlreadyResolved);

        market.resolved = true;
        market.winner = None; // No winner for closed market

        emit!(MarketClosed {
            market_id: market.id,
        });

        Ok(())
    }
}

// Clean, efficient account structures
#[account]
pub struct GlobalState {
    pub authority: Pubkey,      // 32
    pub fee_bps: u16,          // 2
    pub fee_recipient: Pubkey,  // 32
    pub total_markets: u64,     // 8
    pub bump: u8,              // 1
}

#[account]
pub struct Market {
    pub id: u64,                    // 8
    pub creator: Pubkey,            // 32
    pub question: String,           // 4 + 200
    pub outcomes: Vec<String>,      // 4 + (4 + 50) * 8 = 436
    pub end_time: i64,             // 8
    pub oracle: Pubkey,            // 32
    pub min_bet: u64,              // 8
    pub total_pool: u64,           // 8
    pub outcome_pools: Vec<u64>,   // 4 + 8 * 8 = 68
    pub resolved: bool,            // 1
    pub winner: Option<u8>,        // 1 + 1
    pub created_at: i64,           // 8
    pub bump: u8,                  // 1
}

#[account]
pub struct UserBet {
    pub user: Pubkey,        // 32
    pub market: Pubkey,      // 32
    pub bets: Vec<u64>,      // 4 + 8 * 8 = 68
    pub total_bet: u64,      // 8
    pub claimed: bool,       // 1
    pub bump: u8,           // 1
}

// Account contexts - practical constraints
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 75,
        seeds = [b"global"],
        bump
    )]
    pub global_state: Account<'info, GlobalState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct CreateMarket<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + 815,
        seeds = [b"market", market_id.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = creator,
        seeds = [b"vault", market.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = market_vault,
    )]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub global_state: Account<'info, GlobalState>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + 142,
        seeds = [b"bet", user.key().as_ref(), market.key().as_ref()],
        bump
    )]
    pub user_bet: Account<'info, UserBet>,
    #[account(mut)]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    pub global_state: Account<'info, GlobalState>,
    pub resolver: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimWinnings<'info> {
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub user_bet: Account<'info, UserBet>,
    #[account(mut)]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    pub global_state: Account<'info, GlobalState>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CollectFees<'info> {
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub fee_token_account: Account<'info, TokenAccount>,
    pub global_state: Account<'info, GlobalState>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseMarket<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    pub global_state: Account<'info, GlobalState>,
    pub authority: Signer<'info>,
}

// Clean events
#[event]
pub struct PlatformInitialized {
    pub authority: Pubkey,
    pub fee_bps: u16,
}

#[event]
pub struct MarketCreated {
    pub market_id: u64,
    pub question: String,
    pub outcomes: Vec<String>,
    pub end_time: i64,
    pub oracle: Pubkey,
}

#[event]
pub struct BetPlaced {
    pub user: Pubkey,
    pub market_id: u64,
    pub outcome_index: u8,
    pub amount: u64,
}

#[event]
pub struct MarketResolved {
    pub market_id: u64,
    pub winner: u8,
}

#[event]
pub struct WinningsClaimed {
    pub user: Pubkey,
    pub market_id: u64,
    pub amount: u64,
}

#[event]
pub struct FeesCollected {
    pub market_id: u64,
    pub amount: u64,
}

#[event]
pub struct MarketClosed {
    pub market_id: u64,
}

// Essential error codes - not excessive
#[error_code]
pub enum ErrorCode {
    #[msg("Fee too high")]
    FeeTooHigh,
    #[msg("Invalid outcomes")]
    InvalidOutcomes,
    #[msg("Invalid end time")]
    InvalidEndTime,
    #[msg("End time too far")]
    EndTimeTooFar,
    #[msg("Invalid question")]
    InvalidQuestion,
    #[msg("Invalid outcome")]
    InvalidOutcome,
    #[msg("Invalid min bet")]
    InvalidMinBet,
    #[msg("Market resolved")]
    MarketResolved,
    #[msg("Market expired")]
    MarketExpired,
    #[msg("Bet too small")]
    BetTooSmall,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Already resolved")]
    AlreadyResolved,
    #[msg("Too early to resolve")]
    TooEarly,
    #[msg("No winners")]
    NoWinners,
    #[msg("Market not resolved")]
    NotResolved,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("No winning bet")]
    NoWinningBet,
    #[msg("Invalid payout")]
    InvalidPayout,
} 