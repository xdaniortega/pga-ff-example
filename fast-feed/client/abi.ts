// The slice of the Tickets / ERC20 interface the CLI and the mock feed use.
// Source of truth: contracts/src/fast-feed/vendor/ITickets.sol (github.com/OffchainLabs/feed-ticket-contracts).
// Human-readable ABI so the CLI works without a forge build (no dependency on out/).
import { parseAbi } from 'viem'

export const ticketsAbi = parseAbi([
  'function purchaseTickets(uint256 expectedRound, uint256 expectedPrice, uint256 numTicketsDesired, bytes32 apiKeyHash)',
  'function depositToken(uint256 amount)',
  'function withdrawToken(uint256 amount)',
  'function tokenBalance(address account) view returns (uint256)',
  'function grandfatherCount(address account) view returns (uint256)',
  'function thisRoundTicketCount(address account) view returns (uint256)',
  'function roundNumber() view returns (uint256)',
  'function roundStart() view returns (uint256)',
  'function roundEnd() view returns (uint256)',
  'function grandfatherPeriodEnd() view returns (uint256)',
  'function currentPrice() view returns (uint256)',
  'function roundDuration() view returns (uint256)',
  'function minimumPrice() view returns (uint256)',
  'function targetTicketsPerRound() view returns (uint256)',
  'function maxTicketsPerRound() view returns (uint256)',
  'function priceUpdateFraction() view returns (uint256)',
  'function grandfatherPeriodFraction() view returns (uint256)',
  'function ticketsSoldThisRound() view returns (uint256)',
  'event TicketsPurchased(address indexed buyer, uint256 indexed round, bytes32 indexed apiKeyHash, uint256 price, uint256 numTickets, uint256 numTicketsDesired)',
  'event TokensDeposited(address indexed depositor, uint256 amount)',
  'event TokensWithdrawn(address indexed withdrawer, uint256 amount)',
  'error RoundNumberMismatch(uint256 expected, uint256 actual)',
  'error IncorrectTicketPrice(uint256 expected, uint256 actual)',
  'error ZeroTicketsRequested()',
  'error MaxTicketsSold()',
  'error InsufficientTokenBalance(uint256 balance, uint256 required)',
  'error NotEnoughGrandfatheredTickets(uint256 grandfatheredTickets, uint256 requestedTickets)',
  'error BeforeFirstRoundStart()',
])

export const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function mint(address to, uint256 amount)', // local TestToken only
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
])
