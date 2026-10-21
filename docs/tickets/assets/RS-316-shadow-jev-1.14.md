# Pre-screen shadow run: `typesafe/jev-1.14`

Window: last 14 days. Billed LLM verdicts: 11102 (793/day). Sampled: 1578 listings (93 scored 4+, 32 scored 3, 1453 scored 1-2, each standing for 7.5). Decision calls failed: 0.

Per call: median 170 ms, p95 236 ms, $0.000064; at 793 calls/day that is $0.051/day for the pre-screen.

## Label agreement (decision choice vs LLM score)

| LLM score | n | reject | maybe | buy |
|---|---|---|---|---|
| 1 | 1434 | 1426 | 2 | 6 |
| 2 | 19 | 16 | 2 | 1 |
| 3 | 32 | 4 | 16 | 12 |
| 4 | 70 | 12 | 0 | 58 |
| 5 | 23 | 1 | 1 | 21 |

## Gate on P(reject) >= threshold

| threshold | billed calls saved | 4+ kept | 3+ kept | 4+ dropped |
|---|---|---|---|---|
| 0.50 | 97.9% | 87.1% | 87.2% | 12 |
| 0.60 | 97.3% | 89.2% | 89.6% | 10 |
| 0.70 | 97.0% | 90.3% | 91.2% | 9 |
| 0.80 | 96.1% | 92.5% | 92.8% | 7 |
| 0.90 | 93.1% | 93.5% | 93.6% | 6 |
| 0.95 | 89.8% | 95.7% | 96.0% | 4 |
| 0.98 | 84.5% | 97.8% | 98.4% | 2 |
| 0.99 | 79.8% | 98.9% | 99.2% | 1 |

**No-go**: no threshold keeps >= 99% of the 4+ listings while saving >= 50% of billed calls.

## 4+ listings a gate at 0.99 would have dropped (1)

| LLM | P(reject) | choice | title | price | url |
|---|---|---|---|---|---|
| 5 | 0.99 | reject | 2x8 sticks of samsung 3200 ddr4 laptop ram | $50 | $70 | https://www.facebook.com/marketplace/item/1612567530548410/?ref=search&referral_code=null&referral_story_type=post&tracking=browse_serp%3A78958af5-142a-4d52-bbd8-81c663fd9017&__tn__=!%3AD |

## 4+ listings the model was least sure about (P(reject) 0.20-0.99)

| LLM | P(reject) | title | price |
|---|---|---|---|
| 4 | 0.98 | A-Tech 64GB (2x32GB) DDR4 2400MHz Desktop RAM Kit, Brand New Sealed | $450 |
| 4 | 0.97 | I7 8700k, Z370 Asus motherboard, and 16 DDR4-3000mhz ram | $175 |
| 4 | 0.95 | Dell R740xd Server with 768GB RAM | $4,000 |
| 4 | 0.94 | 8Gb(2) DDR4 3200 | $125 |
| 4 | 0.91 | 32 GB DDR4 2400T (4 x 8 GB stick) | $60 |
| 4 | 0.87 | 16 gb DDR4 Desktop RAM – 2x8 gb OLOy Memory Sticks (2400MHz) - 3 kits  | $40 |
| 4 | 0.79 | Two Servers And server Parts (hba cards, boss card w/2x240gb ssd’s, an | $380 | $450 |
| 4 | 0.70 | SSD, DDR4, motherboard, psu lot | $1,500 |
| 4 | 0.64 | Samsung 8x16GB DDR4 PC4-2133P Server RAM M393A2G40DB0-CPB0Q | $500 | $600 |
| 4 | 0.53 | DDR5 16GB (2x 8GB) SODIMM | $150 | $160 |
