# 🏓 Pickleball Queuing System – Complete Tutorial Guide

Welcome to the **Pickleball Queuing System** (PicklQ / Deuce Club)! This is your complete, step-by-step guide to every feature the system offers — from first login to end-of-day archiving.

---

## 📖 Table of Contents

1. [Getting Started – Login & Registration](#-1-getting-started--login--registration)
2. [Understanding the Dashboard](#-2-understanding-the-dashboard)
3. [Adding Players to the System](#-3-adding-players-to-the-system)
4. [Managing Courts](#-4-managing-courts)
5. [Understanding the Queue System](#-5-understanding-the-queue-system)
6. [Starting Matches – Auto-Assign](#-6-starting-matches--auto-assign)
7. [Round Generator & Matching Modes](#-7-round-generator--matching-modes)
8. [Custom Match Builder](#-8-custom-match-builder)
9. [Finishing Matches & Tracking Winners](#-9-finishing-matches--tracking-winners)
10. [Managing Player Status](#-10-managing-player-status)
11. [Player Management Table](#-11-player-management-table)
12. [Match Log](#-12-match-log)
13. [Player Rankings](#-13-player-rankings)
14. [TV Display Mode](#-14-tv-display-mode)
15. [Sharing the TV Display (QR Code)](#-15-sharing-the-tv-display-qr-code)
16. [Installing as a Mobile App (PWA)](#-16-installing-as-a-mobile-app-pwa)
17. [Admin Panel – User Management](#-17-admin-panel--user-management)
18. [End of Day – Archiving](#-18-end-of-day--archiving)
19. [Auto-Logout & Session Security](#-19-auto-logout--session-security)
20. [Pro Tips & FAQ](#-20-pro-tips--faq)

---

## 🔐 1. Getting Started – Login & Registration

### Logging In
1. Open the app URL in your browser (e.g., `https://your-site.netlify.app/login.html`).
2. Enter your **Email** and **Password**.
3. Complete the **reCAPTCHA** verification (proves you're not a bot).
4. Click **"Sign In"**.

> **Note:** After multiple failed login attempts, a lockout banner will appear showing how many attempts remain. This protects against unauthorized access.

### Registering a New Account
1. On the login page, click **"Register here"** below the sign-in button.
2. Fill in:
   - **Email** – Your email address
   - **Password** – Minimum 6 characters
   - **Display Name** – Your name as it appears in the system
   - **Club** – Select your club:
     - **Deuce Club** – Default branding
     - **Longos Pickleball Club** – Longos-specific branding & logo
     - **Guest** – PicklQ generic branding
3. Complete the **reCAPTCHA** and click **"Register Account"**.

> **Tip:** The club selection determines the logo, title, and branding you see throughout the app. Each club shares the same system but gets its own visual identity.

---

## 🖥️ 2. Understanding the Dashboard

After login, you'll land on the **main dashboard** (`index.html`). Here's what you'll see:

### Top Stats Bar (4 cards)
| Stat | What It Shows |
|------|---------------|
| **Total Waiting Players** | Number of players currently queued up |
| **Active Matches** | Number of courts with ongoing games |
| **Available Courts** | Number of courts ready for a new match |
| **Queue Counts** | Breakdown per skill: Beginner, Intermediate, Advanced |

### Sidebar Navigation (left side)
| Button | Action |
|--------|--------|
| 📋 **Match Log** | View all completed matches |
| 📈 **Ranking** | View player leaderboard |
| ➕ **Import Players** | Go to the bulk import page |
| 🖥️ **View TV Display** | Open the spectator TV view |
| 🔗 **Share TV** | Generate a QR code for the TV display |
| 📖 **User Guide** | Open the built-in quick-start guide |
| 🚪 **Logout** | Sign out of the system |

> **Mobile users:** Tap the ☰ hamburger menu (top-left) to open the sidebar.

### Main Sections (scrolling down)
1. **Courts** – Live court cards with match control
2. **Queues** – Three skill-tier queues with drag-and-drop reorder
3. **Player Management** – Full player table with search, filter, add, and actions

---

## 📋 3. Adding Players to the System

You have **three** ways to add players:

### Method A: Bulk Import via Spreadsheet
1. Click **"Import Players"** in the sidebar → opens `import.html`.
2. Click **"Choose File"** and upload a `.xlsx` or `.csv` file.
3. Your spreadsheet should have these columns:

| Column | Required? | Values |
|--------|-----------|--------|
| `Name` | ✅ Yes | Player's full name |
| `Skill` | ✅ Yes | `Beginner`, `Intermediate`, or `Advanced` |
| `Gender` | Optional | `Male`, `Female`, or `Unspecified` |
| `Location` | Optional | e.g., `Lobby`, `Court Side`, `Bench 3` |

4. Review the **Preview table** — make sure everything looks correct.
5. Click **"Save to Queue"** to import all players.

> **Need a template?** Download the included **Excel Template** or **CSV Template** directly from the Import page.

### Method B: Import from Reclub
1. On the Import page, click the green **"Import from Reclub"** button.
2. Copy your participant list from the Reclub app and **paste it** into the text area.
3. The system auto-parses numbered lists like:
   ```
   Participants (26)
   1. Player One
   2. Player Two
   3. Player Three | rating=4.2 | duprId=23q4321
   ```
4. Click **"Import Players"** → all parsed players are added.

### Method C: Walk-in (Add One at a Time)
1. On the Dashboard, scroll to **Player Management**.
2. Click the **"Add Player"** button → a modal opens.
3. Fill in: **Name**, **Skill Level**, **Gender**, and optionally **Location**.
4. Click **"Add Player"**.

> **Important:** All newly added players start as **Standby**. You need to click **"Return to Queue"** next to their name to officially queue them up for matches.

---

## 🏟️ 4. Managing Courts

### Adding Courts
1. In the **Courts** section at the top, click **"+ Add Court"**.
2. A new court card appears (Court 1, Court 2, etc.).
3. You can add as many courts as your venue has.

### Court Status
Each court card shows one of these statuses:

| Status | Meaning |
|--------|---------|
| 🟢 **Available** | Ready for a new match |
| 🔴 **In Progress** | A match is currently being played |

### Court Cards Show:
- **Court name** and current status
- **Match timer** – how long the current game has been running
- **Team A** and **Team B** with player names
- **"End Match"** button to finish the current game

---

## 🔄 5. Understanding the Queue System

The system uses **three skill-based queues** with FIFO (First-In, First-Out) rotation:

| Queue | Color | Description |
|-------|-------|-------------|
| **Beginner – Low Intermediate** | 🟢 Teal | For beginner-level players |
| **High Intermediate – Advanced** | 🟡 Gold | For intermediate-level players |
| **Advanced++** | 🟠 Orange | For advanced-level players |

Each queue card shows:
- **Total players waiting** in that queue
- **Estimated wait time** (in minutes)
- **Upcoming matches** — groups of 4 players ready to play

### Drag and Drop
You can **drag and drop** match groups within and between queues to manually reorder the priority.

---

## ⚡ 6. Starting Matches – Auto-Assign

### Auto-Assign Toggle
1. In the Courts section, find the **"Auto-Assign"** toggle switch.
2. **Turn it ON** → the system will automatically:
   - Detect when a court becomes available
   - Pull the next group of 4 from the appropriate queue
   - Start the match immediately
3. This keeps courts busy without manual intervention!

### Manual Start
If Auto-Assign is OFF, matches from the queue will be displayed as **pending** and you can manually assign them to available courts.

---

## 🎲 7. Round Generator & Matching Modes

The **Round Generator** is a powerful feature that creates multiple matches at once for all standby players.

### How to Use It
1. Scroll to Player Management → find the **"Round Generator"** panel (green border).
2. Click **"Generate Round"** → a **Matching Mode** modal appears.
3. Choose one of **6 matching modes**:

| Mode | Description | Best For |
|------|-------------|----------|
| ⚖️ **Balanced** *(Recommended)* | Balances teams by win ratio; avoids repeat matchups | Competitive fairness |
| 🤝 **Social Mix** *(Improved)* | Rotates partners/opponents fairly; stats not used | Casual social play |
| 🎯 **Skill Separated** | Keeps similar skill levels together | Organized skill brackets |
| 🏆 **Winners / Losers** | Winners play winners, losers play losers | Tournament-style rotation |
| 👫 **Mixed Doubles** | Each team gets one male + one female player | Mixed-gender events |
| 🔀 **Flex Borrow** | If a queue is short by 1–3 players, borrows from Intermediate | Uneven skill turnout |

4. Click **"Generate Matches"** → the system auto-creates as many balanced groups of 4 as possible and queues them up.

---

## 🛠️ 8. Custom Match Builder

Need full control over who plays with whom? Use the **Custom Match Builder**.

1. In the Player Management section, click **"Configure Match"** in the Custom Match panel (orange border).
2. A modal opens with **4 dropdown selectors**:
   - **Team A:** Player 1 + Player 2
   - **Team B:** Player 3 + Player 4
3. Select any waiting players from the dropdowns.
4. **Optional:** Click **"⚖️ Auto-Balance"** to have the system suggest the fairest team split.
5. If the system detects a **⚠️ Repeat Matchup**, a warning badge will appear.
6. Click **"Queue Custom Match"** → the match is queued and waits for an available court.

> **Note:** Custom matches **bypass** skill restrictions — you can mix any skill levels together.

---

## ✅ 9. Finishing Matches & Tracking Winners

When a game on a court is done:

1. Click **"End Match"** on the court card.
2. A **Winner Selection modal** pops up with three options:

| Option | What Happens |
|--------|--------------|
| **Team A Wins 🏆** | Team A gets +1 Win, Team B gets +1 Loss |
| **Team B Wins 🏆** | Team B gets +1 Win, Team A gets +1 Loss |
| **No Winner / Just End Match** | No stats recorded; match still ends |

3. After selection:
   - All 4 players move to **"Done Playing"** (Standby) status.
   - The court becomes **Available** for the next match.
   - If Auto-Assign is ON, the next queued match starts automatically.

---

## 🙋 10. Managing Player Status

Each player goes through a **status lifecycle**:

```
[New/Imported] → Standby → Waiting (Queued) → Playing → Standby (Done)
                    ↕                                        ↕
                  Absent ←————————————————————————→ Return to Queue
```

### Status Actions

| Action | When to Use | Result |
|--------|-------------|--------|
| **Return to Queue** | Player is ready to play again | Placed at the **bottom** of their skill queue |
| **Absent** | Player needs a break / leaves temporarily | Removed from queue; won't be called for matches |
| **Archive** | Player leaves for the day | Moved to archived status; stats preserved |
| **Edit** | Need to change a player's info | Update name, skill, gender, or location |

---

## 📊 11. Player Management Table

The Player Management section organizes all players into **4 skill-separated tables**:

1. **Beginner Players** (teal header)
2. **Intermediate Players** (gold header)
3. **Advanced Players** (orange header)
4. **Done Playing** (players who finished their last match)

### Table Columns

| Column | Description |
|--------|-------------|
| **#** | Row number |
| **Player** | Name (with skill badge) |
| **Gender** | Male / Female / Unspecified |
| **Location** | Where the player is sitting |
| **Status** | Current status (Waiting, Standby, Absent, Playing) |
| **Last Match** | Timestamp of their last completed game |
| **GP** (purple) | Games Played total |
| **W** (green) | Wins count |
| **L** (red) | Losses count |
| **Win %** (blue) | Win percentage |
| **Skill** | Editable skill level |
| **Actions** | Return / Absent / Archive / Edit buttons |

### Search & Filter
- **Search bar** – Type a name to instantly filter the table
- **Filter dropdown** – Filter by:
  - All Skills
  - Beginner only
  - Intermediate only
  - Advanced only
  - Archived Status

---

## 📓 12. Match Log

View the complete history of all matches played.

### How to Open
Click **📋 Match Log** in the sidebar → a full-screen modal opens.

### What's Shown

| Column | Description |
|--------|-------------|
| **Time** | When the match was completed |
| **Court** | Which court was used |
| **Skill** | Skill level of the match |
| **Team A** | Names of Team A players |
| **Team B** | Names of Team B players |
| **Winner** | Which team won (or "No Winner") |
| **Duration** | How long the match lasted |
| **Action** | Archive individual match records |

### Features
- **Pagination** – Navigate through match history with Prev/Next buttons
- **Show Archived** – Toggle to view previously archived matches
- **Archive All** – Archive all current match logs at once
- Matches are sorted **newest first**

---

## 🏆 13. Player Rankings

View the full player leaderboard sorted by performance.

### How to Open
Click **📈 Ranking** in the sidebar → a modal opens with the full ranking table.

### Ranking Criteria
Players are ranked by:
1. **Win Percentage** (primary) – higher is better
2. **Matches Played** (tiebreaker) – more games played ranks higher

### Table Columns
| Column | Description |
|--------|-------------|
| **Rank** | Position (1st, 2nd, 3rd, etc.) |
| **Player** | Player name |
| **Skill** | Skill level |
| **GP** | Games Played |
| **W** | Wins |
| **L** | Losses |
| **Win %** | Win percentage |

---

## 📺 14. TV Display Mode

Show a live, spectator-friendly display on a big screen or TV!

### How to Access
1. Open your browser on the TV/display screen.
2. Navigate to: `https://your-site.netlify.app/tv.html`
3. Or from the Dashboard sidebar, click **"View TV Display"**.

### What the TV Display Shows

**Section 1: Live Courts**
- All active courts with:
  - Court name and status (Available / In Progress)
  - Live match timer
  - Team A and Team B player names

**Section 2: Upcoming Matches**
- The next queued matches waiting for courts

**Section 3: Daily Leaderboard** 🏅
- **1st Place** (Gold crown 👑) – Largest card, center position
- **2nd Place** (Silver) – Left side
- **3rd Place** (Bronze) – Right side
- Each shows: Player name, Win count, and Win Rate

**Section 4: Full Player Rankings**
- Grid of all players ranked by performance
- Shows rank, name, wins, losses, and win percentage

> The TV display updates **in real-time** — no manual refresh needed!

---

## 🔗 15. Sharing the TV Display (QR Code)

Make it easy for spectators to view the live queue on their phones.

1. In the sidebar, click **"Share TV"**.
2. A modal pops up with:
   - A **QR code** – spectators scan it with their phone camera
   - A **shareable link** – copy and send to anyone
3. Click **"Copy"** to copy the URL to your clipboard.

---

## 📱 16. Installing as a Mobile App (PWA)

The system is a **Progressive Web App (PWA)** — you can install it on your phone or tablet for a native app experience!

### On iPhone / iPad (Safari)
1. Open the app URL in Safari.
2. Tap the **Share** button (square with arrow).
3. Scroll down and tap **"Add to Home Screen"**.
4. Tap **"Add"** — the app icon appears on your home screen.

### On Android (Chrome)
1. Open the app URL in Chrome.
2. Tap the **three-dot menu** (⋮) → **"Add to Home Screen"** or **"Install App"**.
3. Confirm — the app installs with its own icon.

### Benefits of Installing
- Opens in **full screen** (no browser UI)
- **Faster loading** with offline caching
- Feels like a native mobile app

---

## 👨‍💼 17. Admin Panel – User Management

The Admin Panel lets you manage who has access to the system.

### How to Access
Navigate to: `https://your-site.netlify.app/admin.html`

### Features
- View all **Registered Users** in a table:
  - **Name** – User's display name
  - **Email** – Login email
  - **Role** – User role (Admin, Operator, etc.)
  - **Joined Date** – When they registered
  - **Actions** – Manage user accounts (approve, change role, remove)

> **Security:** Only admin-level users can access this page. Non-admin users will be redirected.

---

## 🌙 18. End of Day – Archiving

When your session is finished for the day:

1. Scroll to the **Player Management** section.
2. Click the red **"End Day (Archive All)"** button.
3. **Confirm** the action in the popup.

### What Archiving Does
- ✅ All active players are moved to **Archived** status
- ✅ All queues and courts are **cleared**
- ✅ Player stats (Wins, Losses, Games Played) are **preserved**
- ✅ Next time you import the same player, their **historical stats are retained**

> **Tip:** You can also archive individual players by clicking the Archive button next to their name in the Player Management table.

---

## 🔒 19. Auto-Logout & Session Security

The system includes built-in security features:

- **Auto-Logout Timer** – If you're inactive for an extended period, the system will automatically log you out to prevent unauthorized access.
- **reCAPTCHA Protection** – Login and registration forms are protected against bots.
- **Lockout Protection** – Multiple failed login attempts trigger a temporary lockout with a cooldown timer.
- **Session Persistence** – Your login session persists across browser refreshes (via Firebase Auth).

---

## 🎉 20. Pro Tips & FAQ

### 💡 Tips for Smooth Operations

| Tip | Details |
|-----|---------|
| **Use Import for large groups** | Start each session by importing your attendee list — much faster than adding one-by-one |
| **Turn on Auto-Assign** | Let the system automatically fill courts as they become available |
| **Use the Round Generator** | One click generates a balanced set of matches for all waiting players |
| **Track locations** | Use the Location field to note where players are sitting so you can find them easily |
| **Use the TV Display** | Set up a screen at your venue so everyone can see the queue and leaderboard |
| **Share the QR code** | Print or display the QR code so spectators can follow along on their phones |
| **Check the Match Log** | Review match history to resolve any disputes about who played whom |
| **Install the PWA** | Install the app on your device for faster access and a better experience |

### ❓ Frequently Asked Questions

**Q: A player was called but they're not ready. What do I do?**
> Mark them as **Absent**. When they return, click **"Return to Queue"** — they'll go to the back of the line.

**Q: Can I rearrange the queue order?**
> Yes! The queue section supports **drag and drop**. Grab a match group and move it up or down.

**Q: What happens if there aren't enough players for a full group of 4?**
> The remaining players stay in the queue until more arrive. You can also use **Flex Borrow** mode to borrow from the Intermediate queue.

**Q: Can I mix skill levels in a match?**
> Yes! Use the **Custom Match Builder** — it bypasses skill restrictions. Or use **Social Mix** mode in the Round Generator.

**Q: Where are the player stats stored?**
> Stats are stored in **Firebase Firestore** and persist across sessions. Archiving does NOT delete stats.

**Q: Can multiple operators use the system at the same time?**
> Yes! The system uses **real-time Firebase sync** — all changes appear instantly for every logged-in user.

**Q: How do I change a player's skill level?**
> In the Player Management table, click the **Skill dropdown** in that player's row to change it, or use the **Edit** action.

**Q: What's the difference between the Round Generator and Auto-Assign?**
> - **Auto-Assign** continuously fills courts one-by-one as they become available (takes the next group from the queue).
> - **Round Generator** creates a full batch of balanced matches all at once using your chosen matching algorithm.

---

### 📞 Need Help?

If you run into any issues, check that:
1. You're using a modern browser (Chrome, Safari, Firefox, Edge)
2. You have a stable internet connection (the system requires Firebase)
3. Your account has the proper permissions

---

*Last updated: September 2026*
