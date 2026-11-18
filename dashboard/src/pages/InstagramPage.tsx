import { InstagramCard } from "../components/cards/InstagramCard";

export default function InstagramPage() {
  return (
    <div className="max-w-[900px]">
      <h2 className="mb-4 text-xl font-semibold text-fg">Instagram Bot</h2>
      <div className="rounded-lg border border-line bg-surface p-4">
        <InstagramCard />
      </div>
    </div>
  );
}
