# 🏓 Pickleball Queuing System – User Tutorial

Welcome to the **Pickleball Queuing System**! This guide will explain how to use the system to manage your courts, organize players, and keep the games running smoothly.

---

## 📋 1. Adding Players to the System

You have two ways to add players: bulk import or individual walk-ins.

### Bulk Import (Best for starting the day)
1. Click the **"Import Players"** button at the top right of the dashboard.
2. Upload a `.csv` or `.xlsx` file containing your player list. Ensure your spreadsheet has these columns:
   - `Name` (Required)
   - `Skill` (Required: Beginner, Intermediate, or Advanced)
   - `Gender` (Optional: Male, Female)
   - `Location` (Optional: e.g., "Lobby", "Outside")
3. Review the preview table to ensure the data is correct.
4. Click **"Save to Queue"**. All valid players will be instantly added to the back of their respective skill queues.

### Walk-ins (Adding one at a time)
1. On the main Dashboard, go to the **Player Management** section.
2. Fill out the "Add Player" form (Name, Skill, Gender, Location).
3. Click **"Add Player"**. 
4. The player is automatically added to the *bottom* of the waitlist for their skill level.

---

## 🏟️ 2. Managing the Courts

The system is designed with specific rules for your courts to ensure fair and balanced play:

- **Court 1:** `Beginner Only`
- **Court 2:** `Intermediate Only`
- **Court 3:** `Any Skill` (Random / Unrestricted)

### Starting a Match (Auto-Assign)
When a court is **Available**:
1. Click the **"Start Next Match"** dropdown on the court card.
2. The system will suggest the next available group of 4 players based on the court's rules (e.g., Court 1 will only suggest from the Beginner queue).
3. Click the suggested queue to instantly assign the top 4 players to the court.

### Starting a Custom Match (Stacking)
If you need to manually group players:
1. Scroll down to the **Player Management** table.
2. Check the box in the **"Stack"** column next to the 4 players you want to group together.
3. The **Custom Match** panel (above the table) will show `4/4 selected`.
4. Click **"Start Custom Match"**.
5. Select the court you want to send them to. (Note: Custom matches bypass the skill restrictions).

---

## 🔄 3. How the Queue Cycles

The system operates on a **fair FIFO (First-In, First-Out)** rotation.

1. **When a Match Finishes:** Click the **"Finish Match"** button on the active court.
2. **Select the Winner (Optional):** Choose which team won to track stats, or just click "Finish without Winner".
3. **Standby Mode:** The 4 players who just finished will have their status changed to `Standby`. They will be grouped at the top of the Player Management table so you can clearly see their Win/Loss status.
4. **Returning to Queue:** When those players are ready to play again, click **"Return to Queue"** next to their name. They will be placed at the **very back** of their respective skill queues.
---

## 🙋 4. Managing Player Availability (Absent / Return)

Sometimes players need to take a break, use the restroom, or leave for a bit.

- **Marking Absent:** In the Player Management table, find the player and click **"Absent"**. This removes them from the active queue so they aren't called for a match while they are away. Their status changes to `Absent`.
- **Returning to Queue:** When the player is back, find them in the table and click **"Return to Queue"**. They will be added to the **bottom** of their skill queue.

---

## 📺 5. The TV Display Mode

If you have a large screen or TV at the club, you can display the real-time queue!
1. Open the URL on the TV's browser.
2. Add `/tv.html` to the end of your Netlify URL (e.g., `https://your-site.netlify.app/tv.html`).
3. This page automatically refreshes and shows a clean, large-text view of the Active Courts and the Next Up players.

---

## 🌙 6. End of the Day (Archiving)

When the session is over, you need to clear the system for the next day.
1. Scroll down to the **Player Management** section.
2. Click the red **"End Day (Archive All)"** button.
3. This will archive all players, clearing the active queues and courts, but remembering the players so they can be easily "Revived" if they are imported again next time.

---

### 🎉 Pro Tips
- You can filter the player list by Skill or Status using the **Filter** dropdown above the table to easily find someone.
- The player table shows how many Wins (`W`) and Losses (`L`) a player has accumulated during the session.
- **Location tracking:** Use the Location field to remember where a player is sitting so you can find them when their name is called!
