use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

declare_id!("11111111111111111111111111111112");

#[program]
pub mod prediction_market {
    use super::*;

    /// Initialize the global state for the prediction market platform
    pub fn initialize(
        ctx: Context<Initialize>,
        platform_fee_bps: u16, // Fee in basis points (e.g., 100 = 1%)
        fee_recipient: Pubkey,
    ) -> Result<()> {
        let global_state = &mut ctx.accounts.global_state;
        global_state.authority = ctx.accounts.authority.key();
        global_state.platform_fee_bps = platform_fee_bps;
        global_state.fee_recipient = fee_recipient;
        global_state.total_markets = 0;
        global_state.bump = ctx.bumps.global_state;

        emit!(PlatformInitialized {
            authority: ctx.accounts.authority.key(),
            platform_fee_bps,
            fee_recipient,
        });

        Ok(())
    }

    /// Create a new prediction market
    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: u64,
        question: String,
        outcomes: Vec<String>,
        end_time: i64,
        oracle: Pubkey,
        min_bet: u64,
    ) -> Result<()> {
        require!(outcomes.len() >= 2, ErrorCode::InsufficientOutcomes);
        require!(outcomes.len() <= 10, ErrorCode::TooManyOutcomes);
        require!(end_time > Clock::get()?.unix_timestamp, ErrorCode::InvalidEndTime);
        require!(question.len() <= 200, ErrorCode::QuestionTooLong);
        require!(min_bet > 0, ErrorCode::InvalidMinBet);

        let market = &mut ctx.accounts.market;
        market.id = market_id;
        market.creator = ctx.accounts.creator.key();
        market.question = question.clone();
        market.outcomes = outcomes.clone();
        market.end_time = end_time;
        market.oracle = oracle;
        market.min_bet = min_bet;
        market.status = MarketStatus::Active;
        market.total_pool = 0;
        market.outcome_pools = vec![0; outcomes.len()];
        market.winning_outcome = None;
        market.created_at = Clock::get()?.unix_timestamp;
        market.bump = ctx.bumps.market;

        // Update global state
        let global_state = &mut ctx.accounts.global_state;
        global_state.total_markets += 1;

        emit!(MarketCreated {
            market_id,
            creator: ctx.accounts.creator.key(),
            question,
            outcomes,
            end_time,
            oracle,
            min_bet,
        });

        Ok(())
    }

    /// Place a bet on a specific outcome
    pub fn place_bet(
        ctx: Context<PlaceBet>,
        outcome_index: u8,
        amount: u64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let user_bet = &mut ctx.accounts.user_bet;
        let clock = Clock::get()?;

        // Validate market state
        require!(market.status == MarketStatus::Active, ErrorCode::MarketNotActive);
        require!(clock.unix_timestamp < market.end_time, ErrorCode::MarketExpired);
        require!(outcome_index < market.outcomes.len() as u8, ErrorCode::InvalidOutcome);
        require!(amount >= market.min_bet, ErrorCode::BetTooSmall);

        // Transfer tokens from user to market vault
        let transfer_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.market_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
        );
        token::transfer(transfer_ctx, amount)?;

        // Update user bet
        if user_bet.user == Pubkey::default() {
            // First bet from this user
            user_bet.user = ctx.accounts.user.key();
            user_bet.market = market.key();
            user_bet.bets = vec![0; market.outcomes.len()];
            user_bet.total_bet = 0;
            user_bet.claimed = false;
            user_bet.bump = ctx.bumps.user_bet;
        }

        user_bet.bets[outcome_index as usize] += amount;
        user_bet.total_bet += amount;

        // Update market totals
        market.total_pool += amount;
        market.outcome_pools[outcome_index as usize] += amount;

        emit!(BetPlaced {
            user: ctx.accounts.user.key(),
            market_id: market.id,
            outcome_index,
            amount,
            total_pool: market.total_pool,
        });

        Ok(())
    }

    /// Resolve a market (only by oracle or authority)
    pub fn resolve_market(
        ctx: Context<ResolveMarket>,
        winning_outcome: u8,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        // Validate permissions
        require!(
            ctx.accounts.resolver.key() == market.oracle || 
            ctx.accounts.resolver.key() == ctx.accounts.global_state.authority,
            ErrorCode::UnauthorizedResolver
        );

        // Validate market state
        require!(market.status == MarketStatus::Active, ErrorCode::MarketNotActive);
        require!(clock.unix_timestamp >= market.end_time, ErrorCode::MarketNotExpired);
        require!(winning_outcome < market.outcomes.len() as u8, ErrorCode::InvalidOutcome);

        // Update market state
        market.status = MarketStatus::Resolved;
        market.winning_outcome = Some(winning_outcome);

        emit!(MarketResolved {
            market_id: market.id,
            winning_outcome,
            resolver: ctx.accounts.resolver.key(),
            total_pool: market.total_pool,
        });

        Ok(())
    }

    /// Claim winnings for a user
    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        let market = &ctx.accounts.market;
        let user_bet = &mut ctx.accounts.user_bet;
        let global_state = &ctx.accounts.global_state;

        // Validate market state
        require!(market.status == MarketStatus::Resolved, ErrorCode::MarketNotResolved);
        require!(!user_bet.claimed, ErrorCode::AlreadyClaimed);
        require!(user_bet.user == ctx.accounts.user.key(), ErrorCode::UnauthorizedClaim);

        let winning_outcome = market.winning_outcome.unwrap();
        let user_winning_bet = user_bet.bets[winning_outcome as usize];
        
        if user_winning_bet == 0 {
            return Err(ErrorCode::NoWinningBet.into());
        }

        // Calculate winnings
        let winning_pool = market.outcome_pools[winning_outcome as usize];
        let total_pool = market.total_pool;
        
        // Calculate platform fee
        let platform_fee = (total_pool * global_state.platform_fee_bps as u64) / 10000;
        let prize_pool = total_pool - platform_fee;
        
        // Calculate user's share of the prize pool
        let user_winnings = (user_winning_bet * prize_pool) / winning_pool;

        // Transfer winnings to user
        let market_key = market.key();
        let seeds = &[
            b"market_vault",
            market_key.as_ref(),
            &[ctx.bumps.market_vault],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_accounts = Transfer {
            from: ctx.accounts.market_vault.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.market_vault.to_account_info(),
        };
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
            signer_seeds,
        );
        token::transfer(transfer_ctx, user_winnings)?;

        // Mark as claimed
        user_bet.claimed = true;

        emit!(WinningsClaimed {
            user: ctx.accounts.user.key(),
            market_id: market.id,
            amount: user_winnings,
        });

        Ok(())
    }

    /// Collect platform fees (only by authority)
    pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
        let market = &ctx.accounts.market;
        let global_state = &ctx.accounts.global_state;

        // Validate permissions
        require!(
            ctx.accounts.authority.key() == global_state.authority,
            ErrorCode::UnauthorizedFeeCollection
        );

        // Validate market state
        require!(market.status == MarketStatus::Resolved, ErrorCode::MarketNotResolved);

        // Calculate platform fee
        let platform_fee = (market.total_pool * global_state.platform_fee_bps as u64) / 10000;

        if platform_fee > 0 {
            // Transfer fees to fee recipient
            let market_key = market.key();
            let seeds = &[
                b"market_vault",
                market_key.as_ref(),
                &[ctx.bumps.market_vault],
            ];
            let signer_seeds = &[&seeds[..]];

            let transfer_accounts = Transfer {
                from: ctx.accounts.market_vault.to_account_info(),
                to: ctx.accounts.fee_recipient_token_account.to_account_info(),
                authority: ctx.accounts.market_vault.to_account_info(),
            };
            let transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                transfer_accounts,
                signer_seeds,
            );
            token::transfer(transfer_ctx, platform_fee)?;

            emit!(FeesCollected {
                market_id: market.id,
                amount: platform_fee,
                recipient: global_state.fee_recipient,
            });
        }

        Ok(())
    }

    /// Emergency function to close a market (only by authority)
    pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let global_state = &ctx.accounts.global_state;

        // Validate permissions
        require!(
            ctx.accounts.authority.key() == global_state.authority,
            ErrorCode::UnauthorizedMarketClose
        );

        market.status = MarketStatus::Cancelled;

        emit!(MarketClosed {
            market_id: market.id,
            authority: ctx.accounts.authority.key(),
        });

        Ok(())
    }
}

// Account structures
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + GlobalState::INIT_SPACE,
        seeds = [b"global_state"],
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
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", market_id.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = creator,
        seeds = [b"market_vault", market.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = market_vault,
    )]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"global_state"],
        bump = global_state.bump
    )]
    pub global_state: Account<'info, GlobalState>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(outcome_index: u8, amount: u64)]
pub struct PlaceBet<'info> {
    #[account(
        mut,
        seeds = [b"market", market.id.to_le_bytes().as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserBet::INIT_SPACE,
        seeds = [b"user_bet", user.key().as_ref(), market.key().as_ref()],
        bump
    )]
    pub user_bet: Account<'info, UserBet>,
    #[account(
        mut,
        seeds = [b"market_vault", market.key().as_ref()],
        bump
    )]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = market_vault.mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(winning_outcome: u8)]
pub struct ResolveMarket<'info> {
    #[account(
        mut,
        seeds = [b"market", market.id.to_le_bytes().as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        seeds = [b"global_state"],
        bump = global_state.bump
    )]
    pub global_state: Account<'info, GlobalState>,
    pub resolver: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimWinnings<'info> {
    #[account(
        seeds = [b"market", market.id.to_le_bytes().as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"user_bet", user.key().as_ref(), market.key().as_ref()],
        bump = user_bet.bump
    )]
    pub user_bet: Account<'info, UserBet>,
    #[account(
        mut,
        seeds = [b"market_vault", market.key().as_ref()],
        bump
    )]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = market_vault.mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(
        seeds = [b"global_state"],
        bump = global_state.bump
    )]
    pub global_state: Account<'info, GlobalState>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(
        seeds = [b"market", market.id.to_le_bytes().as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"market_vault", market.key().as_ref()],
        bump
    )]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = market_vault.mint,
        associated_token::authority = global_state.fee_recipient,
    )]
    pub fee_recipient_token_account: Account<'info, TokenAccount>,
    #[account(
        seeds = [b"global_state"],
        bump = global_state.bump
    )]
    pub global_state: Account<'info, GlobalState>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseMarket<'info> {
    #[account(
        mut,
        seeds = [b"market", market.id.to_le_bytes().as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        seeds = [b"global_state"],
        bump = global_state.bump
    )]
    pub global_state: Account<'info, GlobalState>,
    pub authority: Signer<'info>,
}

// Data structures
#[account]
#[derive(InitSpace)]
pub struct GlobalState {
    pub authority: Pubkey,
    pub platform_fee_bps: u16,
    pub fee_recipient: Pubkey,
    pub total_markets: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub id: u64,
    pub creator: Pubkey,
    #[max_len(200)]
    pub question: String,
    #[max_len(10, 50)]
    pub outcomes: Vec<String>,
    pub end_time: i64,
    pub oracle: Pubkey,
    pub min_bet: u64,
    pub status: MarketStatus,
    pub total_pool: u64,
    #[max_len(10)]
    pub outcome_pools: Vec<u64>,
    pub winning_outcome: Option<u8>,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserBet {
    pub user: Pubkey,
    pub market: Pubkey,
    #[max_len(10)]
    pub bets: Vec<u64>,
    pub total_bet: u64,
    pub claimed: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum MarketStatus {
    Active,
    Resolved,
    Cancelled,
}

// Events
#[event]
pub struct PlatformInitialized {
    pub authority: Pubkey,
    pub platform_fee_bps: u16,
    pub fee_recipient: Pubkey,
}

#[event]
pub struct MarketCreated {
    pub market_id: u64,
    pub creator: Pubkey,
    #[index]
    pub question: String,
    pub outcomes: Vec<String>,
    pub end_time: i64,
    pub oracle: Pubkey,
    pub min_bet: u64,
}

#[event]
pub struct BetPlaced {
    #[index]
    pub user: Pubkey,
    pub market_id: u64,
    pub outcome_index: u8,
    pub amount: u64,
    pub total_pool: u64,
}

#[event]
pub struct MarketResolved {
    pub market_id: u64,
    pub winning_outcome: u8,
    pub resolver: Pubkey,
    pub total_pool: u64,
}

#[event]
pub struct WinningsClaimed {
    #[index]
    pub user: Pubkey,
    pub market_id: u64,
    pub amount: u64,
}

#[event]
pub struct FeesCollected {
    pub market_id: u64,
    pub amount: u64,
    pub recipient: Pubkey,
}

#[event]
pub struct MarketClosed {
    pub market_id: u64,
    pub authority: Pubkey,
}

// Error codes
#[error_code]
pub enum ErrorCode {
    #[msg("Insufficient outcomes for market")]
    InsufficientOutcomes,
    #[msg("Too many outcomes for market")]
    TooManyOutcomes,
    #[msg("Invalid end time")]
    InvalidEndTime,
    #[msg("Question too long")]
    QuestionTooLong,
    #[msg("Invalid minimum bet")]
    InvalidMinBet,
    #[msg("Market is not active")]
    MarketNotActive,
    #[msg("Market has expired")]
    MarketExpired,
    #[msg("Invalid outcome index")]
    InvalidOutcome,
    #[msg("Bet amount too small")]
    BetTooSmall,
    #[msg("Unauthorized resolver")]
    UnauthorizedResolver,
    #[msg("Market has not expired yet")]
    MarketNotExpired,
    #[msg("Market is not resolved")]
    MarketNotResolved,
    #[msg("Winnings already claimed")]
    AlreadyClaimed,
    #[msg("Unauthorized claim")]
    UnauthorizedClaim,
    #[msg("No winning bet")]
    NoWinningBet,
    #[msg("Unauthorized fee collection")]
    UnauthorizedFeeCollection,
    #[msg("Unauthorized market close")]
    UnauthorizedMarketClose,
}
