# Chrome Extension — Submission Guide

## Prerequisites
1. Chrome Web Store Developer Account ($5 one-time fee)
   - https://chrome.google.com/webstore/devconsole/register

## Steps

### 1. Create the ZIP
```bash
cd chrome-extension
zip -r vigil-chrome-extension.zip manifest.json popup.html content.js badge.css icons/
```

### 2. Upload to Chrome Web Store
1. Go to https://chrome.google.com/webstore/devconsole
2. Click "New Item"
3. Upload `vigil-chrome-extension.zip`

### 3. Fill in Store Listing
- **Name**: VIGIL — Trust Score for Polymarket
- **Summary**: See trust scores for any Polymarket trader. VIGIL scores 6 dimensions of forecasting skill so you can separate signal from noise.
- **Description**:
```
VIGIL adds trust score badges directly to Polymarket profile pages.

Instead of blindly following wallets with high PnL, see their actual forecasting skill scored across 6 dimensions:

• Calibration — are their confidence levels accurate?
• Live Edge — are open positions beating the market?
• Profitability — actual P&L performance
• Consistency — steady returns vs one lucky hit
• Discipline — position sizing and risk management
• Sample Size — enough bets to be meaningful

Features:
- Trust badges on Polymarket profile pages
- Hover tooltip with full score breakdown
- Popup search — score any wallet instantly
- Link to full scorecard on vigil-trust-api.onrender.com

Free. No account required. No tracking.
```

- **Category**: Productivity
- **Language**: English

### 4. Icons & Screenshots
- Upload vigil-128.png as the store icon
- Take screenshots of:
  1. Badge on a Polymarket profile page
  2. Hover tooltip showing score breakdown
  3. Extension popup with search results

### 5. Privacy
- **Single purpose**: Display trust scores for Polymarket prediction market traders
- **Permissions justification**:
  - `activeTab`: Read wallet address from Polymarket page URL
  - `host_permissions` for polymarket.com: Inject trust score badges
  - `host_permissions` for vigil API: Fetch trust score data
- **Data use**: No user data collected. No analytics. No tracking.

### 6. Submit for Review
- Click "Submit for Review"
- Typical review: 1-3 business days
- May need to respond to reviewer questions about permissions

## Post-Launch
- Update TOP_WALLETS with a note about the extension
- Add "Chrome Extension" badge to VIGIL homepage
- Announce in viral thread
