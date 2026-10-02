import { createIcons, RefreshCw, Download, Upload, Copy, LogOut, ChevronLeft, ChevronRight, X, Check, AlertTriangle, Clock, ArrowUpRight, Pause, Play, Plus, Square } from 'lucide';

export function renderIcons() {
  createIcons({ icons: { RefreshCw, Download, Upload, Copy, LogOut, ChevronLeft, ChevronRight, X, Check, AlertTriangle, Clock, ArrowUpRight, Pause, Play, Plus, Square }, attrs: { width: 17, height: 17, 'aria-hidden': 'true' } });
}
