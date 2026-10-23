import { createT } from "@codesh/i18n";
import {
  Bell,
  Copy,
  FileCode2,
  Link2,
  LogOut,
  Pencil,
  Plus,
  Search,
  Settings,
  Share2,
  Trash2,
  Users,
  WifiOff,
} from "lucide-react";
import { useState } from "react";
import {
  Avatar,
  AvatarStack,
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kbd,
  KbdGroup,
  LanguageBadge,
  PinInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProgressBar,
  Select,
  Sheet,
  SheetContent,
  SheetTrigger,
  Skeleton,
  SkeletonText,
  Spinner,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  toast,
} from "../src/index.js";
import { Label, Row, Section, ThemePair, usePanelContainer } from "./lib.js";

const t = createT("ko");

const PEOPLE = [
  { id: "a", name: "김현민", slot: 1 },
  { id: "b", name: "Ada Lovelace", slot: 2 },
  { id: "c", name: "박서연", slot: 3 },
  { id: "d", name: "Grace Hopper", slot: 4 },
  { id: "e", name: "이도윤", slot: 5 },
  { id: "f", name: "Linus T.", slot: 6 },
  { id: "g", name: "정하늘", slot: 7 },
] as const;

const LANGUAGE_OPTIONS = [
  { value: "typescript", label: "TypeScript" },
  { value: "python", label: "Python" },
  { value: "java", label: "Java" },
  { value: "kotlin", label: "Kotlin" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
  { value: "sql", label: "SQL" },
];

function ButtonsSpecimen() {
  const [loading, setLoading] = useState(false);
  return (
    <>
      <Label>Variants</Label>
      <Row>
        <Button variant="primary">{t("common.save")}</Button>
        <Button variant="secondary">{t("common.cancel")}</Button>
        <Button variant="ghost">{t("common.close")}</Button>
        <Button variant="soft">{t("common.copy")}</Button>
        <Button variant="danger">{t("common.delete")}</Button>
      </Row>
      <Label>Sizes · with icons</Label>
      <Row>
        <Button size="sm" variant="primary" leading={<Plus />}>
          sm
        </Button>
        <Button size="md" variant="primary" leading={<Plus />}>
          md
        </Button>
        <Button size="lg" variant="primary" leading={<Share2 />}>
          lg
        </Button>
        <Button variant="secondary" trailing={<Link2 />}>
          {t("common.copy")}
        </Button>
      </Row>
      <Label>States · loading, disabled</Label>
      <Row>
        <Button
          variant="primary"
          loading={loading}
          loadingLabel={t("common.loading")}
          onClick={() => {
            setLoading(true);
            window.setTimeout(() => setLoading(false), 900);
          }}
        >
          {t("common.save")}
        </Button>
        <Button variant="primary" loading loadingLabel={t("common.loading")}>
          {t("common.save")}
        </Button>
        <Button variant="secondary" disabled>
          disabled
        </Button>
        <Button variant="danger" disabled>
          disabled
        </Button>
      </Row>
      <Label>IconButton · 24 / 28 / 32 / 40px, toggle</Label>
      <Row>
        <IconButton size="xs" aria-label="Copy">
          <Copy />
        </IconButton>
        <IconButton size="sm" aria-label="Edit">
          <Pencil />
        </IconButton>
        <IconButton size="md" variant="secondary" aria-label="Settings">
          <Settings />
        </IconButton>
        <IconButton size="lg" variant="soft" aria-label="Notifications">
          <Bell />
        </IconButton>
        <IconButton size="md" pressed aria-label="Participants">
          <Users />
        </IconButton>
        <IconButton size="md" variant="danger" aria-label="Delete">
          <Trash2 />
        </IconButton>
      </Row>
    </>
  );
}

function InputsSpecimen() {
  const [pin, setPin] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <>
      <div className="flex max-w-sm flex-col gap-3">
        <Field label={t("share.joinWithCode")} hint="6자리 숫자">
          <Input
            placeholder={t("share.codePlaceholder")}
            inputMode="numeric"
            leading={<Search />}
          />
        </Field>
        <Field label="공유 이름" error="이름은 80자까지 쓸 수 있어요" required>
          <Input
            defaultValue={"가".repeat(5)}
            trailing={<span className="text-caption">5/80</span>}
          />
        </Field>
        <Input aria-label="disabled" placeholder="disabled" disabled />
      </div>
      <Label>PinInput · 6 digits, paste a code like “482 913”</Label>
      <PinInput
        aria-label="참여 코드"
        getDigitLabel={(i, n) => `${n}자리 중 ${i}번째`}
        value={pin}
        onValueChange={(v) => {
          setPin(v);
          setBad(false);
        }}
        onComplete={(v) => setBad(v !== "482913")}
        invalid={bad}
      />
      <p className="mt-2 text-caption text-fg-3" role="status">
        {bad ? "코드가 맞지 않아요 (정답: 482913)" : "482913을 입력해 보세요"}
      </p>
    </>
  );
}

function SelectSpecimen() {
  const container = usePanelContainer();
  const [value, setValue] = useState("typescript");
  return (
    <div className="flex max-w-xs flex-col gap-3">
      <Select
        aria-label="Language"
        value={value}
        onValueChange={setValue}
        options={LANGUAGE_OPTIONS}
        container={container}
      />
      <Select
        aria-label="Empty"
        placeholder="언어 선택"
        options={LANGUAGE_OPTIONS}
        container={container}
      />
      <Select
        aria-label="Invalid"
        invalid
        options={LANGUAGE_OPTIONS}
        placeholder="invalid"
        container={container}
      />
    </div>
  );
}

function SwitchSpecimen() {
  const [wrap, setWrap] = useState(true);
  return (
    <div className="flex max-w-sm flex-col gap-4">
      <Switch
        label="줄 바꿈"
        description="긴 줄을 화면 너비에 맞춰 접어요"
        checked={wrap}
        onCheckedChange={setWrap}
      />
      <Row className="gap-4">
        <Switch aria-label="on" defaultChecked />
        <Switch aria-label="off" />
        <Switch aria-label="disabled" disabled defaultChecked />
      </Row>
    </div>
  );
}

function OverlaySpecimen() {
  const container = usePanelContainer();
  const [dir, setDir] = useState("ltr");
  return (
    <>
      <Label>Tooltip (forced open) · Popover · Dropdown menu</Label>
      <Row className="gap-4 pt-8">
        <Tooltip content="링크 복사" shortcut={["⌘", "L"]} open side="top" container={container}>
          <IconButton aria-label="Copy link" variant="secondary">
            <Link2 />
          </IconButton>
        </Tooltip>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="secondary" leading={<Share2 />}>
              {t("share.new")}
            </Button>
          </PopoverTrigger>
          <PopoverContent container={container} align="start">
            <p className="font-medium">참여 코드</p>
            <p className="mt-1 font-mono text-title tabular-nums">482 913</p>
            <p className="mt-2 text-caption text-fg-3">
              같은 네트워크에서 코드만 입력하면 들어와요.
            </p>
          </PopoverContent>
        </Popover>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary">메뉴 열기</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent container={container} align="start">
            <DropdownMenuLabel>공유</DropdownMenuLabel>
            <DropdownMenuItem icon={<Pencil />} shortcut={["F2"]}>
              이름 바꾸기
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Copy />} shortcut={["⌘", "C"]}>
              전체 복사
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem checked>근처에 표시</DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={dir} onValueChange={setDir}>
              <DropdownMenuRadioItem value="ltr">편집 가능</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="view">보기 전용</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>내보내기</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>파일로 저장</DropdownMenuItem>
                <DropdownMenuItem>HTML</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem destructive icon={<LogOut />}>
              공유 나가기
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Row>
      <Label>Dialog · Sheet · Toast</Label>
      <Row>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="secondary" data-open="dialog">
              Dialog
            </Button>
          </DialogTrigger>
          <DialogContent
            title="공유 삭제"
            description="삭제하면 모든 참여자의 화면에서 사라지고 되돌릴 수 없어요."
            closeLabel={t("common.close")}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">{t("common.cancel")}</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button variant="danger">공유 삭제</Button>
                </DialogClose>
              </>
            }
          >
            <Field label="확인을 위해 공유 이름을 입력하세요">
              <Input placeholder="예: 자료구조 실습" />
            </Field>
          </DialogContent>
        </Dialog>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="secondary" data-open="sheet">
              Sheet
            </Button>
          </SheetTrigger>
          <SheetContent
            title="설정"
            description="에디터 모양과 동작을 바꿔요."
            closeLabel={t("common.close")}
          >
            <div className="flex flex-col gap-4">
              <Switch label="줄 바꿈" defaultChecked />
              <Switch label="공백으로 들여쓰기" />
              <Select aria-label="Language" options={LANGUAGE_OPTIONS} defaultValue="python" />
            </div>
          </SheetContent>
        </Sheet>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="secondary" data-open="sheet-bottom">
              Bottom sheet
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" title="참여자" closeLabel={t("common.close")}>
            <ul className="flex flex-col gap-2">
              {PEOPLE.slice(0, 4).map((p) => (
                <li key={p.id} className="flex items-center gap-3">
                  <Avatar name={p.name} slot={p.slot} size="sm" />
                  <span className="text-body-sm">{p.name}</span>
                </li>
              ))}
            </ul>
          </SheetContent>
        </Sheet>
        <Button
          variant="secondary"
          data-open="toast"
          onClick={() => {
            toast({ title: t("share.linkCopied"), tone: "success" });
            toast({
              title: "김현민님이 공유를 보냈어요",
              description: "자료구조 실습 · Python",
              tone: "info",
              action: { label: "열기", altText: "공유 열기", onClick: () => {} },
            });
            toast({
              title: "연결이 끊겼어요",
              description: "변경 내용은 이 기기에 보관돼요.",
              tone: "warning",
            });
          }}
        >
          Toast ×3
        </Button>
      </Row>
    </>
  );
}

function TabsSpecimen() {
  return (
    <div className="flex flex-col gap-6">
      <Tabs defaultValue="share">
        <TabsList aria-label="Sections">
          <TabsTrigger value="share">공유</TabsTrigger>
          <TabsTrigger value="history">이력</TabsTrigger>
          <TabsTrigger value="comments">코멘트</TabsTrigger>
          <TabsTrigger value="off" disabled>
            비활성
          </TabsTrigger>
        </TabsList>
        <TabsContent value="share" className="text-body-sm text-fg-2">
          링크, 코드, QR로 공유해요.
        </TabsContent>
        <TabsContent value="history" className="text-body-sm text-fg-2">
          편집 이력은 소유자만 볼 수 있어요.
        </TabsContent>
        <TabsContent value="comments" className="text-body-sm text-fg-2">
          줄마다 코멘트를 남겨요.
        </TabsContent>
      </Tabs>
      <Tabs defaultValue="a">
        <TabsList variant="segmented" aria-label="Segmented">
          <TabsTrigger value="a">코드</TabsTrigger>
          <TabsTrigger value="b">QR</TabsTrigger>
          <TabsTrigger value="c">보내기</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}

function DisplaySpecimen() {
  return (
    <>
      <Label>Avatar · AvatarStack (+n overflow)</Label>
      <Row className="gap-4">
        <Avatar name="김현민" slot={1} size="xs" />
        <Avatar name="Ada Lovelace" slot={2} size="sm" />
        <Avatar name="박서연" slot={3} size="md" />
        <Avatar name="Grace Hopper" slot={4} size="lg" />
      </Row>
      <div className="mt-3 flex flex-col gap-3">
        <AvatarStack
          people={PEOPLE}
          label="참여자"
          overflowLabel={(n) => `${n}명 더 있음`}
          max={4}
          tooltips
        />
        <AvatarStack
          people={PEOPLE.slice(0, 3)}
          label="참여자"
          overflowLabel={(n) => `${n}명 더`}
          size="sm"
        />
      </div>
      <Label>All 12 participant colours</Label>
      <Row className="gap-1.5">
        {"ABCDEFGHIJKL".split("").map((letter, i) => (
          <Avatar key={letter} name={letter} slot={i + 1} size="md" />
        ))}
      </Row>
      <Label>Badge · LanguageBadge · Kbd</Label>
      <Row>
        <Badge>기본</Badge>
        <Badge tone="accent">새 기능</Badge>
        <Badge tone="success">연결됨</Badge>
        <Badge tone="warning">오프라인</Badge>
        <Badge tone="danger">차단됨</Badge>
        <Badge tone="info">보기 전용</Badge>
        <Badge tone="info" variant="outline">
          outline
        </Badge>
        <Badge tone="warning" size="sm">
          <WifiOff />
          sm
        </Badge>
      </Row>
      <Row className="mt-2 gap-4">
        <LanguageBadge name="Python" color="#3572A5" />
        <LanguageBadge name="Java" color="#b07219" />
        <LanguageBadge name="TypeScript" color="#3178c6" variant="chip" />
        <LanguageBadge name="JSON" color="#292929" variant="chip" />
        <LanguageBadge name="Dockerfile" color="#384d54" />
      </Row>
      <Row className="mt-2 gap-4">
        <KbdGroup keys={["⌘", "K"]} />
        <KbdGroup keys={["Ctrl", "Shift", "P"]} />
        <Kbd>Esc</Kbd>
      </Row>
    </>
  );
}

function FeedbackSpecimen() {
  const [progress, setProgress] = useState(64);
  return (
    <>
      <Label>Skeleton (list rows) · Spinner (&lt; 1s waits only)</Label>
      <div className="flex flex-col gap-3">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          </div>
        ))}
        <SkeletonText lines={3} />
        <Row className="gap-3 text-fg-2">
          <Spinner label={t("common.loading")} size="sm" />
          <Spinner label={t("common.loading")} />
          <Spinner label={t("common.loading")} size="lg" />
        </Row>
      </div>
      <Label>ProgressBar · determinate, indeterminate</Label>
      <div className="flex max-w-sm flex-col gap-3">
        <ProgressBar value={progress} showValue aria-label="업로드" />
        <ProgressBar value={100} tone="success" size="sm" aria-label="완료" />
        <ProgressBar value={null} aria-label="준비 중" />
        <Row>
          <Button size="sm" onClick={() => setProgress((p) => (p >= 100 ? 0 : p + 18))}>
            +18%
          </Button>
        </Row>
      </div>
      <Label>EmptyState · error</Label>
      <div className="grid gap-4 lg:grid-cols-2">
        <EmptyState
          size="sm"
          icon={<FileCode2 />}
          title="아직 공유가 없어요"
          description="새 공유를 만들면 여기에 모여요."
          action={
            <Button variant="primary" leading={<Plus />}>
              {t("share.new")}
            </Button>
          }
        />
        <EmptyState
          size="sm"
          tone="danger"
          icon={<WifiOff />}
          title="불러오지 못했어요"
          description="네트워크를 확인하고 다시 시도해 주세요."
          action={<Button variant="secondary">{t("common.retry")}</Button>}
        />
      </div>
    </>
  );
}

export function ComponentsView() {
  return (
    <div className="flex flex-col gap-12">
      <Section
        id="buttons"
        title="Button · IconButton"
        note="Primary is filled once per view; everything else stays neutral."
      >
        <ThemePair>
          <ButtonsSpecimen />
        </ThemePair>
      </Section>
      <Section id="inputs" title="Input · Field · PinInput">
        <ThemePair>
          <InputsSpecimen />
        </ThemePair>
      </Section>
      <Section id="select-switch" title="Select · Switch">
        <ThemePair>
          <div className="flex flex-col gap-6">
            <SelectSpecimen />
            <SwitchSpecimen />
          </div>
        </ThemePair>
      </Section>
      <Section
        id="overlays"
        title="Tooltip · Popover · Menu · Dialog · Sheet · Toast"
        note="Open each one; floating layers inherit the panel theme."
      >
        <ThemePair>
          <OverlaySpecimen />
        </ThemePair>
      </Section>
      <Section id="tabs" title="Tabs">
        <ThemePair>
          <TabsSpecimen />
        </ThemePair>
      </Section>
      <Section id="display" title="Avatar · Badge · LanguageBadge · Kbd">
        <ThemePair>
          <DisplaySpecimen />
        </ThemePair>
      </Section>
      <Section id="feedback" title="Skeleton · Spinner · ProgressBar · EmptyState">
        <ThemePair>
          <FeedbackSpecimen />
        </ThemePair>
      </Section>
    </div>
  );
}
