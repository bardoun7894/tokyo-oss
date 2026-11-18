import { ChatCard } from "../components/cards/ChatCard";

export default function ChatPage() {
  return (
    <div className="max-w-[900px]">
      <h2 className="mb-4 text-xl font-semibold text-fg">Recent Chat</h2>
      <div className="rounded-lg border border-line bg-surface p-4">
        <ChatCard />
      </div>
    </div>
  );
}
