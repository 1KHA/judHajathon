/*
  Warnings:

  - A unique constraint covering the columns `[sessionId,teamId]` on the table `SessionResult` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "SessionResult_sessionId_teamId_key" ON "SessionResult"("sessionId", "teamId");
