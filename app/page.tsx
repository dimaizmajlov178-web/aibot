import Link from "next/link";
import { Sparkles, ArrowRight } from "lucide-react";

export default function HomePage() {
  return (
    <div className="min-h-[calc(100vh-9rem)] flex items-center justify-center px-4 py-16">
      <div className="max-w-xl w-full text-center space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
          <Sparkles className="h-7 w-7 text-primary" />
        </div>
        <div className="space-y-3">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Здесь будет ваш сервис
          </h1>
          <p className="text-lg text-muted-foreground">
            Опишите, что нужно построить, — и через несколько минут вы увидите
            рабочий прототип на этом месте.
          </p>
        </div>
        <Link
          href="/demo"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Посмотреть демо
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
