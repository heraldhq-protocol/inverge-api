-- Provider identity is no longer Privy-specific: the web client now authenticates
-- with MetaMask Embedded Wallets (Web3Auth), whose stable subject replaces the
-- Privy DID. Rename the column and its unique index; no data is rewritten.
ALTER TABLE "User" RENAME COLUMN "privyDid" TO "providerUserId";
ALTER INDEX "User_privyDid_key" RENAME TO "User_providerUserId_key";
