/**
 * The icon registry — §8.5.
 *
 *   "A single curated set — Lucide — accessed through a named map in
 *    `design-system/icons`, never imported directly by features. The
 *    indirection buys three things: the icon set can be replaced in one file;
 *    every icon has a semantic name (`icon.medication`, not `Pill`) so meaning
 *    survives a set change; and unused icons are trivially auditable."
 *
 * The semantic-name rule is the one that matters most. `Pill` is a picture;
 * `medication` is a meaning. When Lucide renames `Pill` — or when the set is
 * replaced in 2032 — every call site referencing `medication` keeps working,
 * and every call site referencing `Pill` has to be found and reasoned about.
 *
 * ## Adding an icon
 *
 * Import it, add a semantically-named entry. Name it for what it *means* in
 * this product, not for what it depicts. `icon.trend-up`, not `icon.arrow`.
 */

import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  BellOff,
  BookOpen,
  Briefcase,
  Calendar,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDot,
  Clock,
  Cloud,
  CloudOff,
  Copy,
  Download,
  Droplet,
  Dumbbell,
  Eye,
  EyeOff,
  FileText,
  Filter,
  Flame,
  FolderArchive,
  Heart,
  HeartPulse,
  Home,
  Image,
  Info,
  Laptop,
  LayoutGrid,
  LineChart,
  Link2,
  ListChecks,
  Loader2,
  Lock,
  LogOut,
  Menu,
  Minus,
  Moon,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Pill,
  Plus,
  RefreshCw,
  Rows3,
  Search,
  Settings,
  Sparkles,
  Stethoscope,
  Sun,
  Table2,
  Tag,
  Trash2,
  TrendingDown,
  TrendingUp,
  Upload,
  User,
  Wind,
  X,
  type LucideIcon,
} from 'lucide-react';

/**
 * The map. Keys are semantic; values are the current set's implementation.
 *
 * Grouped by what the icon is *for*, so an auditor can see at a glance which
 * domains have coverage and which are borrowing something approximate.
 */
export const ICON_REGISTRY = {
  /* --- Navigation and structure ------------------------------------ */
  'nav.today': Home,
  'nav.body': Activity,
  'nav.mind': Sparkles,
  'nav.timeline': Clock,
  /* The Life pillar. An archive rather than a heart: what lives here is the
     paperwork and the record of a life, not a sentiment about it. */
  'nav.life': FolderArchive,
  /* Work. A briefcase rather than a chart: §4.8's pillar is a career and its
     cost, not a productivity dashboard. */
  'nav.work': Briefcase,
  'nav.library': BookOpen,
  'nav.settings': Settings,
  'nav.menu': Menu,
  'nav.close': X,
  'nav.back': ArrowLeft,
  'nav.forward': ArrowRight,
  'nav.expand': ChevronDown,
  'nav.collapse': ChevronUp,
  'nav.next': ChevronRight,
  'nav.previous': ChevronLeft,
  'nav.more': MoreHorizontal,

  /* --- Actions ------------------------------------------------------ */
  'action.add': Plus,
  'action.remove': Minus,
  'action.edit': Pencil,
  'action.delete': Trash2,
  'action.confirm': Check,
  'action.search': Search,
  'action.filter': Filter,
  'action.copy': Copy,
  'action.download': Download,
  'action.upload': Upload,
  'action.refresh': RefreshCw,
  'action.attach': Paperclip,
  'action.link': Link2,
  'action.sign-out': LogOut,

  /* --- Status ------------------------------------------------------- */
  'status.success': CheckCircle2,
  'status.warning': AlertTriangle,
  'status.error': AlertCircle,
  'status.info': Info,
  'status.loading': Loader2,
  'status.synced': Cloud,
  /** §5.7's visible unsynced state — a correctness signal, not engagement. */
  'status.unsynced': CloudOff,
  'status.locked': Lock,

  /* --- Data and visualisation --------------------------------------- */
  'data.trend-up': TrendingUp,
  'data.trend-down': TrendingDown,
  'data.chart': LineChart,
  /** §8.9(6): "Every chart has a table." This is that toggle. */
  'data.table': Table2,
  'data.grid': LayoutGrid,
  'data.rows': Rows3,
  'data.point': CircleDot,
  'data.tag': Tag,
  /** Sort indicators for §8.11's sortable columns. */
  'data.sort-ascending': ArrowUp,
  'data.sort-descending': ArrowDown,

  /* --- Domains ------------------------------------------------------ */
  'domain.medication': Pill,
  'domain.gym': Dumbbell,
  'domain.skin': Droplet,
  'domain.mood': Heart,
  'domain.sleep': Moon,
  'domain.clinical': Stethoscope,
  'domain.vitals': HeartPulse,
  'domain.journal': FileText,
  'domain.practice': Wind,
  'domain.streak': Flame,
  'domain.routine': ListChecks,
  'domain.appointment': Calendar,

  /* --- Media -------------------------------------------------------- */
  'media.photo': Image,
  'media.camera': Camera,
  'media.show': Eye,
  'media.hide': EyeOff,

  /* --- Identity and theme ------------------------------------------- */
  'identity.user': User,
  'identity.notifications': Bell,
  'identity.notifications-off': BellOff,
  'theme.light': Sun,
  'theme.dark': Moon,
  'theme.system': Laptop,
} as const satisfies Record<string, LucideIcon>;

/** Every legal icon name. A typo is a compile error. */
export type IconName = keyof typeof ICON_REGISTRY;

export const ICON_NAMES = Object.keys(ICON_REGISTRY) as IconName[];

/**
 * Tokenised sizes (§8.5).
 *
 * "Aligned to the type scale so an icon beside text always sits on the same
 * optical baseline." `sm` pairs with `caption`/`body-sm`, `md` with `body`,
 * `lg` with `title`, `xl` with `display`.
 */
export const ICON_SIZES = { sm: 16, md: 20, lg: 24, xl: 32 } as const;

export type IconSize = keyof typeof ICON_SIZES;
