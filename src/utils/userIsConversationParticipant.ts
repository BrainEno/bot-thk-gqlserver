import { Participant } from "../entities/participant";

export function userIsConversationParticipant(
  participants: Array<Participant>,
  userId: string
): boolean {
  return !!participants.find((participant) => participant.userId === userId);
}
