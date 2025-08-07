# Kahoot-like Judging Application - Project Plan and Details

## Overview
This project is a simple real-time judging application inspired by Kahoot. It allows a host to send questions to judges (participants) who can then submit their answers. The system uses a Node.js server with Socket.IO for real-time communication and static HTML pages for the host and judge interfaces.

## Components

### Server (server.js)
- Built with Express and Socket.IO.
- Serves static files from the `public` directory.
- Manages connections and rooms via Socket.IO.
- Maintains a list of connected players (judges) with their names and scores.
- Uses a fixed judge PIN (`1234`) for authentication.
- Listens for:
  - `join-judging`: to join the judge room if the PIN matches.
  - `start-question`: receives an array of questions from the host and broadcasts to judges.
  - `submit-answer`: receives answers from judges (currently logs them).
  - `disconnect`: removes players on disconnect and updates participant list.

### Host Interface (public/host.html)
- Simple HTML page with a button to send questions.
- On button click, emits `start-question` event with an array of predefined questions.
- Questions include text, multiple choices, and the correct answer.

### Judge Interface (public/judge.html)
- Allows a user to enter their name and join the judging session using the fixed PIN.
- Once joined, displays all questions sent by the host.
- For each question, displays the question text and multiple choice buttons.
- Judges can submit answers per question, which are sent back to the server.
- Handles both single question and multiple questions scenarios.
- Displays alerts for errors and welcome messages.

## Data Structures

### Question Object
- `text`: string - The question text.
- `choices`: array of strings - The possible answers.
- `correct`: string - The correct answer (used by host, not sent to judges).

### Answer Submission
- For multiple questions, the judge submits an object with:
  - `questionIndex`: number - Index of the question answered.
  - `answer`: string - The selected answer.

## Communication Flow

1. Host connects and sends an array of questions via `start-question`.
2. Server broadcasts the questions to all judges in the "judge" room.
3. Judges receive questions and render them.
4. Judges submit answers via `submit-answer`.
5. Server logs answers and can be extended to update scores.

## Potential Enhancements
- Implement score calculation and update on the server.
- Add real-time score display for judges and host.
- Add authentication and dynamic PIN generation.
- Improve UI/UX for host and judge pages.
- Add timer and question navigation controls.
- Persist data in a database for session history.

## Technology Stack
- Node.js with Express for server.
- Socket.IO for real-time WebSocket communication.
- Plain HTML, CSS, and JavaScript for client interfaces.

## Running the Project
- Run `node server.js` to start the server on port 3000.
- Access `public/host.html` for the host interface.
- Access `public/judge.html` for the judge interface.
- Use PIN `1234` to join judging sessions.

---

This document summarizes the current state and architecture of the Kahoot-like judging application.
