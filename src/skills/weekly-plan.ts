import type { Skill } from "./types";
import { ownerProfile, prayerOn, shopOn, languageRule } from "../profile";

const skill: Skill = {
  name: "weekly-plan",
  description: "AI-generated weekly plan based on tasks, deadlines, and goals",
  category: "planning",
  args: [
    { name: "focus", type: "string", description: "Optional focus area (e.g. work, learning, health)", required: false },
  ],
  async execute(ctx, args) {
    await ctx.sendUpdate("Analyzing data and generating weekly plan...");

    const tasks = ctx.db.getAllActiveTasks() as any[];
    const projects = ctx.db.getActiveProjects() as any[];
    const goals = ctx.db.getGoals() as any[];

    const today = new Date();
    const weekDays: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      weekDays.push(d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }));
    }

    const prompt = `Generate a practical weekly plan for the owner.

Week: ${weekDays[0]} to ${weekDays[6]}

Active tasks (${tasks.length}):
${tasks.slice(0, 20).map(t => `- [${t.priority}][${t.category}] ${t.title}${t.due_date ? ` (due: ${t.due_date})` : ""}`).join("\n")}

Active projects (${projects.length}):
${projects.map(p => `- ${p.name} (${p.status})${p.deadline ? ` deadline: ${p.deadline}` : ""}`).join("\n")}

Goals: ${goals.length > 0 ? goals.map((g: any) => `${g.title} (${g.current_value}/${g.target_value})`).join(", ") : "none set"}
${args.focus ? `\nFocus area: ${args.focus}` : ""}

${ownerProfile()}

Rules:
${prayerOn() ? "- Schedule around 5 daily prayers — NEVER during prayer times\n- Friday = minimal work, focus on Jumu'ah\n- Include Quran reading daily\n" : ""}- Balance the owner's work, ${shopOn() ? "the shop, " : ""}learning and rest
- ${languageRule()}
- Be specific: which tasks on which days
- Format for Telegram Markdown`;

    const response = await ctx.ai.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const plan = (response.content[0] as any).text;
    return { success: true, output: plan };
  },
};

export default skill;
