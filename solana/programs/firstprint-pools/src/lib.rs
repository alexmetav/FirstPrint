//! Firstprint pools: on-chain parimutuel prediction pools for new exchange listings.
//!
//! One `Market` per listing holds stakes in five outcome buckets
//! (0 Crash, 1 Down, 2 Flat, 3 Up, 4 Moon) inside a token vault owned by the
//! market PDA. Earlier predictions receive a larger weight. After the 72-hour
//! window, the oracle (the Firstprint settlement service) posts the winning
//! bucket plus a hash of the price data it used. Winners claim a share of the
//! pool minus the fee, in proportion to their weighted stake. Voided markets
//! refund every stake in full.
//!
//! ⚠️ UNAUDITED. Devnet only until reviewed by a professional auditor and
//! cleared by legal counsel for each jurisdiction where real money is used.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("5sitA26Dr3fqfJ27YZYcfxxVpZJdgb8S5MTH3PuawxM8"); // replace with `anchor keys sync`

pub const BUCKETS: usize = 5;
pub const BPS: u64 = 10_000;
pub const NO_BUCKET: u8 = u8::MAX;
pub const MAX_FEE_BPS: u16 = 2_000;

#[program]
pub mod firstprint_pools {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        oracle: Pubkey,
        treasury: Pubkey,
        fee_bps: u16,
        early_bird_bps: u16,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, PoolError::InvalidFee);
        require!(early_bird_bps as u64 <= BPS, PoolError::InvalidEarlyBird);
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.oracle = oracle;
        c.treasury = treasury;
        c.fee_bps = fee_bps;
        c.early_bird_bps = early_bird_bps;
        c.paused = false;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        oracle: Pubkey,
        treasury: Pubkey,
        fee_bps: u16,
        early_bird_bps: u16,
        paused: bool,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, PoolError::InvalidFee);
        require!(early_bird_bps as u64 <= BPS, PoolError::InvalidEarlyBird);
        let c = &mut ctx.accounts.config;
        c.oracle = oracle;
        c.treasury = treasury;
        c.fee_bps = fee_bps;
        c.early_bird_bps = early_bird_bps;
        c.paused = paused;
        Ok(())
    }

    /// Opens a market. `id` is the off-chain market id hashed or truncated to 16 bytes.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        id: [u8; 16],
        listing_at: i64,
        close_at: i64,
        settle_at: i64,
        soft_cap: u64,
        user_cap: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now < close_at && listing_at <= close_at && close_at < settle_at, PoolError::InvalidSchedule);
        require!(user_cap > 0 && user_cap <= soft_cap, PoolError::InvalidCaps);

        let m = &mut ctx.accounts.market;
        m.id = id;
        m.mint = ctx.accounts.mint.key();
        m.vault = ctx.accounts.vault.key();
        m.opened_at = now;
        m.listing_at = listing_at;
        m.close_at = close_at;
        m.settle_at = settle_at;
        m.soft_cap = soft_cap;
        m.user_cap = user_cap;
        m.totals = [0; BUCKETS];
        m.weighted = [0; BUCKETS];
        m.status = MarketStatus::Open;
        m.winning_bucket = NO_BUCKET;
        m.return_bps = 0;
        m.data_hash = [0; 32];
        m.fee = 0;
        m.net_pool = 0;
        m.bump = ctx.bumps.market;

        emit!(MarketCreated { market: m.key(), id, listing_at, close_at, settle_at });
        Ok(())
    }

    pub fn place_prediction(ctx: Context<PlacePrediction>, bucket: u8, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &ctx.accounts.config;
        let market = &ctx.accounts.market;
        let b = bucket as usize;

        require!(!cfg.paused, PoolError::Paused);
        require!(market.status == MarketStatus::Open, PoolError::MarketNotOpen);
        require!(now < market.close_at, PoolError::PredictionsClosed);
        require!(b < BUCKETS, PoolError::InvalidBucket);
        require!(amount > 0, PoolError::InvalidAmount);

        let pool_after = market.pool()?.checked_add(amount).ok_or(PoolError::MathOverflow)?;
        require!(pool_after <= market.soft_cap, PoolError::PoolFull);
        let user_after = ctx.accounts.position.total()?.checked_add(amount).ok_or(PoolError::MathOverflow)?;
        require!(user_after <= market.user_cap, PoolError::UserCapExceeded);

        let weight = weight_bps(now, market.opened_at, market.close_at, cfg.early_bird_bps);
        let weighted = (amount as u128).checked_mul(weight as u128).ok_or(PoolError::MathOverflow)?;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let market_key = ctx.accounts.market.key();
        let user_key = ctx.accounts.user.key();

        let p = &mut ctx.accounts.position;
        if p.owner == Pubkey::default() {
            p.market = market_key;
            p.owner = user_key;
            p.claimed = false;
            p.bump = ctx.bumps.position;
        }
        p.stakes[b] = p.stakes[b].checked_add(amount).ok_or(PoolError::MathOverflow)?;
        p.weighted[b] = p.weighted[b].checked_add(weighted).ok_or(PoolError::MathOverflow)?;

        let m = &mut ctx.accounts.market;
        m.totals[b] = m.totals[b].checked_add(amount).ok_or(PoolError::MathOverflow)?;
        m.weighted[b] = m.weighted[b].checked_add(weighted).ok_or(PoolError::MathOverflow)?;

        emit!(PredictionPlaced { market: market_key, user: user_key, bucket, amount, weight_bps: weight });
        Ok(())
    }

    /// Oracle posts the result after the settlement time. Markets with no winners
    /// or only one outcome picked become void and are fully refundable.
    pub fn settle(ctx: Context<Settle>, winning_bucket: u8, return_bps: i32, data_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let market = &ctx.accounts.market;
        require!(market.status == MarketStatus::Open, PoolError::MarketNotOpen);
        require!(now >= market.settle_at, PoolError::TooEarly);
        require!((winning_bucket as usize) < BUCKETS, PoolError::InvalidBucket);

        let pool = market.pool()?;
        let buckets_used = market.totals.iter().filter(|t| **t > 0).count();
        let void = pool == 0 || buckets_used < 2 || market.totals[winning_bucket as usize] == 0;
        let fee = if void { 0 } else { fee_for(pool, ctx.accounts.config.fee_bps) };

        if fee > 0 {
            let id = market.id;
            let bump = [market.bump];
            let seeds: &[&[u8]] = &[b"market".as_ref(), id.as_ref(), bump.as_ref()];
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.treasury_token.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                    },
                    &[seeds],
                ),
                fee,
                ctx.accounts.mint.decimals,
            )?;
        }

        let m = &mut ctx.accounts.market;
        m.status = if void { MarketStatus::Void } else { MarketStatus::Settled };
        m.winning_bucket = winning_bucket;
        m.return_bps = return_bps;
        m.data_hash = data_hash;
        m.fee = fee;
        m.net_pool = pool - fee;

        emit!(MarketSettled { market: m.key(), winning_bucket, return_bps, void, pool, fee, data_hash });
        Ok(())
    }

    /// Cancels an open market (listing delayed or retracted, trading halted, bad data).
    pub fn void_market(ctx: Context<VoidMarket>, reason: u8) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Open, PoolError::MarketNotOpen);
        m.status = MarketStatus::Void;
        emit!(MarketVoided { market: m.key(), reason });
        Ok(())
    }

    /// Winners receive their payout; everyone in a void market gets a refund.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let market = &ctx.accounts.market;
        let p = &ctx.accounts.position;
        require!(!p.claimed, PoolError::AlreadyClaimed);

        let amount = match market.status {
            MarketStatus::Settled => {
                let b = market.winning_bucket as usize;
                payout(market.net_pool, p.weighted[b], market.weighted[b])?
            }
            MarketStatus::Void => p.total()?,
            MarketStatus::Open => return err!(PoolError::NotSettled),
        };
        require!(amount > 0, PoolError::NothingToClaim);

        let id = market.id;
        let bump = [market.bump];
        let seeds: &[&[u8]] = &[b"market".as_ref(), id.as_ref(), bump.as_ref()];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.owner_token.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let market_key = ctx.accounts.market.key();
        let p = &mut ctx.accounts.position;
        p.claimed = true;
        emit!(Claimed { market: market_key, owner: p.owner, amount });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Math (pure, unit tested)
// ---------------------------------------------------------------------------

/// Weight in basis points: 10_000 for the last moment, up to 10_000 + early_bird_bps at open.
pub fn weight_bps(now: i64, opened_at: i64, close_at: i64, early_bird_bps: u16) -> u64 {
    if close_at <= opened_at {
        return BPS;
    }
    let span = (close_at - opened_at) as u128;
    let remaining = (close_at - now).clamp(0, close_at - opened_at) as u128;
    BPS + ((early_bird_bps as u128 * remaining) / span) as u64
}

pub fn fee_for(pool: u64, fee_bps: u16) -> u64 {
    ((pool as u128 * fee_bps as u128) / BPS as u128) as u64
}

/// Share of the net pool for a weighted stake. Rounds down; dust stays in the vault.
pub fn payout(net_pool: u64, position_weighted: u128, bucket_weighted: u128) -> Result<u64> {
    if position_weighted == 0 || bucket_weighted == 0 {
        return Ok(0);
    }
    let v = (net_pool as u128)
        .checked_mul(position_weighted)
        .ok_or(PoolError::MathOverflow)?
        / bucket_weighted;
    Ok(v as u64)
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(id: [u8; 16])]
pub struct CreateMarket<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Market::INIT_SPACE, seeds = [b"market", id.as_ref()], bump)]
    pub market: Account<'info, Market>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [b"vault", market.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlacePrediction<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = mint, has_one = vault)]
    pub market: Account<'info, Market>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = user, token::token_program = token_program)]
    pub user_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = oracle)]
    pub config: Account<'info, Config>,
    pub oracle: Signer<'info>,
    #[account(mut, has_one = mint, has_one = vault)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
        constraint = treasury_token.owner == config.treasury @ PoolError::InvalidTreasury,
    )]
    pub treasury_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct VoidMarket<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = authority.key() == config.oracle || authority.key() == config.admin @ PoolError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(has_one = mint, has_one = vault)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = owner,
        has_one = market,
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = owner, token::token_program = token_program)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub owner: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub oracle: Pubkey,
    /// Owner of the token account that receives fees.
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub early_bird_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum MarketStatus {
    Open,
    Settled,
    Void,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub id: [u8; 16],
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub opened_at: i64,
    pub listing_at: i64,
    pub close_at: i64,
    pub settle_at: i64,
    pub soft_cap: u64,
    pub user_cap: u64,
    pub totals: [u64; BUCKETS],
    pub weighted: [u128; BUCKETS],
    pub status: MarketStatus,
    pub winning_bucket: u8,
    pub return_bps: i32,
    /// sha256 of the settlement inputs published by the Firstprint API.
    pub data_hash: [u8; 32],
    pub fee: u64,
    pub net_pool: u64,
    pub bump: u8,
}

impl Market {
    pub fn pool(&self) -> Result<u64> {
        self.totals
            .iter()
            .try_fold(0u64, |acc, t| acc.checked_add(*t).ok_or(error!(PoolError::MathOverflow)))
    }
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub stakes: [u64; BUCKETS],
    pub weighted: [u128; BUCKETS],
    pub claimed: bool,
    pub bump: u8,
}

impl Position {
    pub fn total(&self) -> Result<u64> {
        self.stakes
            .iter()
            .try_fold(0u64, |acc, s| acc.checked_add(*s).ok_or(error!(PoolError::MathOverflow)))
    }
}

// ---------------------------------------------------------------------------
// Events & errors
// ---------------------------------------------------------------------------

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub id: [u8; 16],
    pub listing_at: i64,
    pub close_at: i64,
    pub settle_at: i64,
}

#[event]
pub struct PredictionPlaced {
    pub market: Pubkey,
    pub user: Pubkey,
    pub bucket: u8,
    pub amount: u64,
    pub weight_bps: u64,
}

#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub winning_bucket: u8,
    pub return_bps: i32,
    pub void: bool,
    pub pool: u64,
    pub fee: u64,
    pub data_hash: [u8; 32],
}

#[event]
pub struct MarketVoided {
    pub market: Pubkey,
    pub reason: u8,
}

#[event]
pub struct Claimed {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum PoolError {
    #[msg("Fee cannot exceed 20%")]
    InvalidFee,
    #[msg("Early-bird bonus cannot exceed 100%")]
    InvalidEarlyBird,
    #[msg("Schedule must satisfy now < close, listing <= close < settle")]
    InvalidSchedule,
    #[msg("Caps must satisfy 0 < user cap <= pool cap")]
    InvalidCaps,
    #[msg("Predictions are paused")]
    Paused,
    #[msg("Market is not open")]
    MarketNotOpen,
    #[msg("Predictions are closed for this market")]
    PredictionsClosed,
    #[msg("Bucket must be 0-4")]
    InvalidBucket,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Pool is full")]
    PoolFull,
    #[msg("Per-user limit reached")]
    UserCapExceeded,
    #[msg("Settlement time has not arrived")]
    TooEarly,
    #[msg("Market has not settled")]
    NotSettled,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Treasury token account owner does not match config")]
    InvalidTreasury,
    #[msg("Only the oracle or admin can do this")]
    Unauthorized,
    #[msg("Math overflow")]
    MathOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weight_runs_from_max_to_one() {
        assert_eq!(weight_bps(0, 0, 100, 5_000), 15_000);
        assert_eq!(weight_bps(50, 0, 100, 5_000), 12_500);
        assert_eq!(weight_bps(100, 0, 100, 5_000), 10_000);
        assert_eq!(weight_bps(500, 0, 100, 5_000), 10_000);
        assert_eq!(weight_bps(-50, 0, 100, 5_000), 15_000);
    }

    #[test]
    fn matches_offchain_worked_example() {
        // Pool 10,000, fee 4%, 250 of 2,500 on the winning bucket (equal weights) → 960.
        let fee = fee_for(10_000, 400);
        assert_eq!(fee, 400);
        let net = 10_000 - fee;
        assert_eq!(payout(net, 250 * 10_000, 2_500 * 10_000).unwrap(), 960);
    }

    #[test]
    fn earlier_winners_earn_more() {
        let early = payout(1_200, 100 * 15_000, 100 * 15_000 + 100 * 10_000).unwrap();
        let late = payout(1_200, 100 * 10_000, 100 * 15_000 + 100 * 10_000).unwrap();
        assert_eq!((early, late), (720, 480));
    }

    #[test]
    fn payouts_never_exceed_net_pool() {
        let weights = [333u128 * 13_700, 777 * 10_200, 1_001 * 15_000];
        let total: u128 = weights.iter().sum();
        let paid: u64 = weights.iter().map(|w| payout(2_021, *w, total).unwrap()).sum();
        assert!(paid <= 2_021);
    }
}
