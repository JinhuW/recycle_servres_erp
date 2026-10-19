# Pre-screen shadow run: `openai/gpt-6-luna-decisions`

Window: last 14 days. Billed LLM verdicts: 11099 (793/day). Sampled: 1578 listings (93 scored 4+, 32 scored 3, 1453 scored 1-2, each standing for 7.5). Decision calls failed: 0.

Per call: median 191 ms, p95 265 ms, $0.000126; at 793 calls/day that is $0.100/day for the pre-screen.

## Label agreement (decision choice vs LLM score)

| LLM score | n | reject | maybe | buy |
|---|---|---|---|---|
| 1 | 1434 | 1431 | 0 | 3 |
| 2 | 19 | 18 | 0 | 1 |
| 3 | 32 | 22 | 1 | 9 |
| 4 | 70 | 32 | 1 | 37 |
| 5 | 23 | 4 | 0 | 19 |

## Gate on P(reject) >= threshold

| threshold | billed calls saved | 4+ kept | 3+ kept | 4+ dropped |
|---|---|---|---|---|
| 0.50 | 98.4% | 68.8% | 62.4% | 29 |
| 0.60 | 97.9% | 75.3% | 68.8% | 23 |
| 0.70 | 97.0% | 79.6% | 76.0% | 19 |
| 0.80 | 94.3% | 86.0% | 83.2% | 13 |
| 0.90 | 87.4% | 93.5% | 89.6% | 6 |
| 0.95 | 77.9% | 96.8% | 93.6% | 3 |
| 0.98 | 62.3% | 97.8% | 95.2% | 2 |
| 0.99 | 44.7% | 97.8% | 96.0% | 2 |

**No-go**: no threshold keeps >= 99% of the 4+ listings while saving >= 50% of billed calls.

## 4+ listings a gate at 0.99 would have dropped (2)

| LLM | P(reject) | choice | title | price | url |
|---|---|---|---|---|---|
| 4 | 0.99 | reject | I7 8700k, Z370 Asus motherboard, and 16 DDR4-3000mhz ram | $175 | https://www.facebook.com/marketplace/item/1133534869190058/?ref=search&referral_code=null&referral_story_type=post&tracking=browse_serp%3Abd93f60e-5316-4b5a-9a71-909a7e4d2691&__tn__=!%3AD |
| 4 | 0.99 | reject | HP BL465c BL685c Gen 7 + 3.83TB RAM + Upgraded CPU | $34,365 | https://www.facebook.com/marketplace/item/1627794045471383/?ref=search&referral_code=null&referral_story_type=post&tracking=browse_serp%3Adc042a97-e021-469c-bab0-a0a88141aa67&__tn__=!%3AD |

## 4+ listings the model was least sure about (P(reject) 0.20-0.99)

| LLM | P(reject) | title | price |
|---|---|---|---|
| 5 | 0.97 | 2x8 sticks of samsung 3200 ddr4 laptop ram | $50 | $70 |
| 4 | 0.94 | Two Servers And server Parts (hba cards, boss card w/2x240gb ssd’s, an | $380 | $450 |
| 4 | 0.94 | 16x1 ddr4 ram | $50 |
| 4 | 0.93 | 16 gb DDR4 Desktop RAM – 2x8 gb OLOy Memory Sticks (2400MHz) - 3 kits  | $40 |
| 4 | 0.89 | 32 GB DDR4 2400T (4 x 8 GB stick) | $60 |
| 4 | 0.89 | A-Tech 64GB (2x32GB) DDR4 2400MHz Desktop RAM Kit, Brand New Sealed | $450 |
| 4 | 0.88 | DESKTOP & LAPTOP RAM DDR5, DDR4, DDR3, and DDR2 Options | $1 |
| 4 | 0.84 | Dell R740xd Server with 768GB RAM | $4,000 |
| 4 | 0.84 | Laptop / mini PC  ddr3 ddr4 | $160 |
| 4 | 0.84 | LAPTOP RAM LOT 124GB | $300 |
