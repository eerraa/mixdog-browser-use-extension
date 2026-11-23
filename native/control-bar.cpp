#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <tlhelp32.h>
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

// Slim, owner-docked, non-focus-stealing Win32 Control Bar for Camoufox.
// - No WS_EX_TOPMOST: attaches as an owned popup (GWLP_HWNDPARENT) to the
//   front-most visible Camoufox browser window so it moves, resizes, minimizes
//   and Z-orders natively with Camoufox and never floats over other apps.
// - Never injects DOM/chrome into Camoufox windows (preserves Firefox 158
//   outerHeight/innerHeight/mozInnerScreenY fingerprint verbatim).
// - Receives newline-JSON state updates on stdin and emits button clicks on
//   stdout; exits cleanly on stdin EOF or quit.

static constexpr UINT WM_STATE_UPDATE = WM_APP + 1;
static constexpr UINT WM_FLASH_BAR = WM_APP + 2;
static constexpr UINT_PTR TIMER_DOCK = 1;
static constexpr int BAR_HEIGHT = 36;
static constexpr int MIN_BAR_WIDTH = 560;
static constexpr int ID_COMBO = 101;
static constexpr int ID_PRIMARY = 102;
static constexpr int ID_RETURN_ALL = 103;
static constexpr int ID_STOP = 104;
static constexpr int ID_REVERT = 105;
static constexpr int ID_REVOKE = 106;

struct TabState {
  std::wstring id;
  std::wstring label;
  std::wstring statusText;
  std::wstring primaryText;
  std::wstring primaryAction;
  bool stopEnabled = true;
  bool needsReturn = false;
};

struct BarState {
  bool korean = true;
  bool elevated = false;
  bool visible = false;
  DWORD browserPid = 0;
  std::wstring activeId;
  std::vector<TabState> tabs;
};

static std::mutex g_mutex;
static BarState g_state;
static HWND g_hwnd = nullptr;
static HWND g_combo = nullptr;
static HWND g_status = nullptr;
static HWND g_primary = nullptr;
static HWND g_returnAll = nullptr;
static HWND g_stop = nullptr;
static HWND g_revert = nullptr;
static HWND g_revoke = nullptr;
static HFONT g_font = nullptr;
static HBRUSH g_bgNormal = nullptr;
static HBRUSH g_bgHandoff = nullptr;
static HBRUSH g_bgElevated = nullptr;

static HWND g_dockTarget = nullptr;
static RECT g_lastBarRect{0, 0, 0, 0};
static bool g_barShown = false;
static bool g_showReturnAll = false;
static bool g_showRevert = false;
static int g_bgKind = 0; // 0 = normal, 1 = handoff, 2 = elevated
static std::set<DWORD> g_cachedPids;
static DWORD g_cachedRootPid = 0;
static ULONGLONG g_lastPidScanTick = 0;

using DwmGetWindowAttributeFn = HRESULT (WINAPI*)(HWND, DWORD, PVOID, DWORD);
static DwmGetWindowAttributeFn g_dwmGetWindowAttr = nullptr;
static constexpr DWORD kDwmwaExtendedFrameBounds = 9;

static void initDwm() {
  HMODULE mod = LoadLibraryW(L"dwmapi.dll");
  if (mod) {
    FARPROC proc = GetProcAddress(mod, "DwmGetWindowAttribute");
    g_dwmGetWindowAttr = reinterpret_cast<DwmGetWindowAttributeFn>(reinterpret_cast<void*>(proc));
  }
}

static bool getVisibleWindowRect(HWND hwnd, RECT* out) {
  if (!hwnd || !out) return false;
  if (g_dwmGetWindowAttr && SUCCEEDED(g_dwmGetWindowAttr(hwnd, kDwmwaExtendedFrameBounds, out, sizeof(RECT)))) {
    if (out->right > out->left && out->bottom > out->top) return true;
  }
  return GetWindowRect(hwnd, out) != FALSE;
}

static std::wstring utf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  if (len <= 0) return L"";
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), len);
  return out;
}

static std::string wideToUtf8(const std::wstring& s) {
  if (s.empty()) return "";
  int len = WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0, nullptr, nullptr);
  if (len <= 0) return "";
  std::string out(len, '\0');
  WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), len, nullptr, nullptr);
  return out;
}

static std::string jsonEscape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 4);
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(static_cast<char>(c)); }
    else if (c >= 0x20) out.push_back(static_cast<char>(c));
  }
  return out;
}

static void emitAction(const std::string& action, const std::string& tabId = "") {
  if (tabId.empty()) {
    std::printf("{\"action\":\"%s\"}\n", jsonEscape(action).c_str());
  } else {
    std::printf("{\"action\":\"%s\",\"tabId\":\"%s\"}\n", jsonEscape(action).c_str(), jsonEscape(tabId).c_str());
  }
  std::fflush(stdout);
}

static bool extractString(const std::string& src, const std::string& key, std::string& out, size_t start = 0, size_t end = std::string::npos) {
  const std::string needle = "\"" + key + "\":\"";
  size_t pos = src.find(needle, start);
  if (pos == std::string::npos || (end != std::string::npos && pos >= end)) return false;
  pos += needle.size();
  std::string res;
  while (pos < src.size() && (end == std::string::npos || pos < end)) {
    char c = src[pos++];
    if (c == '"') { out = res; return true; }
    if (c == '\\' && pos < src.size()) {
      char e = src[pos++];
      if (e == 'n' || e == 't' || e == 'r') res.push_back(' ');
      else res.push_back(e);
    } else res.push_back(c);
  }
  return false;
}

static bool extractBool(const std::string& src, const std::string& key, bool def, size_t start = 0, size_t end = std::string::npos) {
  const std::string needle = "\"" + key + "\":";
  size_t pos = src.find(needle, start);
  if (pos == std::string::npos || (end != std::string::npos && pos >= end)) return def;
  pos += needle.size();
  if (src.compare(pos, 4, "true") == 0) return true;
  if (src.compare(pos, 5, "false") == 0) return false;
  return def;
}

static DWORD extractUint32(const std::string& src, const std::string& key, DWORD def, size_t start = 0, size_t end = std::string::npos) {
  const std::string needle = "\"" + key + "\":";
  size_t pos = src.find(needle, start);
  if (pos == std::string::npos || (end != std::string::npos && pos >= end)) return def;
  pos += needle.size();
  unsigned long val = 0;
  bool any = false;
  while (pos < src.size() && (end == std::string::npos || pos < end) && src[pos] >= '0' && src[pos] <= '9') {
    val = val * 10 + static_cast<unsigned long>(src[pos++] - '0');
    any = true;
  }
  return any ? static_cast<DWORD>(val) : def;
}

static void parseStateLine(const std::string& line) {
  std::string cmd;
  if (!extractString(line, "cmd", cmd)) return;
  if (cmd == "quit") {
    if (g_hwnd) PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
    return;
  }
  if (cmd == "flash") {
    if (g_hwnd) PostMessageW(g_hwnd, WM_FLASH_BAR, 0, 0);
    return;
  }
  if (cmd != "state") return;

  BarState next;
  std::string locale;
  if (extractString(line, "locale", locale)) next.korean = (locale.rfind("ko", 0) == 0);
  next.elevated = extractBool(line, "elevated", false);
  next.visible = extractBool(line, "visible", true);
  next.browserPid = extractUint32(line, "browserPid", 0);
  std::string active;
  if (extractString(line, "active", active)) next.activeId = utf8ToWide(active);

  size_t tabsPos = line.find("\"tabs\":[");
  if (tabsPos != std::string::npos) {
    size_t pos = tabsPos + 8;
    while (pos < line.size()) {
      size_t objStart = line.find('{', pos);
      if (objStart == std::string::npos) break;
      size_t objEnd = line.find('}', objStart);
      if (objEnd == std::string::npos) break;
      TabState ts;
      std::string v;
      if (extractString(line, "id", v, objStart, objEnd)) ts.id = utf8ToWide(v);
      if (extractString(line, "label", v, objStart, objEnd)) ts.label = utf8ToWide(v);
      if (extractString(line, "status", v, objStart, objEnd)) ts.statusText = utf8ToWide(v);
      if (extractString(line, "primaryText", v, objStart, objEnd)) ts.primaryText = utf8ToWide(v);
      if (extractString(line, "primaryAction", v, objStart, objEnd)) ts.primaryAction = utf8ToWide(v);
      ts.stopEnabled = extractBool(line, "stopEnabled", true, objStart, objEnd);
      ts.needsReturn = extractBool(line, "needsReturn", false, objStart, objEnd);
      if (!ts.id.empty()) next.tabs.push_back(std::move(ts));
      pos = objEnd + 1;
      if (pos < line.size() && line[pos] == ']') break;
    }
  }
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_state = std::move(next);
  }
  if (g_hwnd) PostMessageW(g_hwnd, WM_STATE_UPDATE, 0, 0);
}

static void stdinThread() {
  std::string line;
  char chunk[4096];
  while (std::fgets(chunk, sizeof(chunk), stdin)) {
    line += chunk;
    if (!line.empty() && line.back() == '\n') {
      while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
      if (!line.empty()) parseStateLine(line);
      line.clear();
    }
  }
  if (g_hwnd) PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
}

static void refreshBrowserPidSet(DWORD rootPid) {
  ULONGLONG now = GetTickCount64();
  if (rootPid == 0) {
    g_cachedPids.clear();
    g_cachedRootPid = 0;
    return;
  }
  if (rootPid == g_cachedRootPid && !g_cachedPids.empty() && (now - g_lastPidScanTick) < 1000) {
    return;
  }
  g_cachedRootPid = rootPid;
  g_lastPidScanTick = now;
  g_cachedPids.clear();
  g_cachedPids.insert(rootPid);

  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return;
  PROCESSENTRY32W pe{};
  pe.dwSize = sizeof(pe);
  if (Process32FirstW(snap, &pe)) {
    do {
      if (pe.th32ParentProcessID == rootPid) {
        g_cachedPids.insert(pe.th32ProcessID);
      }
    } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);
}

struct FindWinCtx {
  const std::set<DWORD>* pids;
  HWND bestVisible = nullptr;
  HWND bestAny = nullptr;
};

static BOOL CALLBACK enumCamoufoxProc(HWND hwnd, LPARAM lp) {
  if (hwnd == g_hwnd) return TRUE;
  auto* ctx = reinterpret_cast<FindWinCtx*>(lp);
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (!ctx->pids->count(pid)) return TRUE;
  if (GetWindow(hwnd, GW_OWNER) != nullptr) return TRUE;
  LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  if (ex & WS_EX_TOOLWINDOW) return TRUE;
  if (!IsWindowVisible(hwnd)) return TRUE;

  wchar_t cls[64]{};
  GetClassNameW(hwnd, cls, 64);
  bool isGecko = (std::wcscmp(cls, L"MozillaWindowClass") == 0);
  RECT rc{};
  GetWindowRect(hwnd, &rc);
  int w = rc.right - rc.left;
  int h = rc.bottom - rc.top;
  if (!isGecko && (w < 200 || h < 120)) return TRUE;

  if (!ctx->bestAny) ctx->bestAny = hwnd;
  if (!IsIconic(hwnd) && !ctx->bestVisible) {
    ctx->bestVisible = hwnd;
    return FALSE; // EnumWindows iterates top-to-bottom in Z-order: first match is front-most.
  }
  return TRUE;
}

static HWND findCamoufoxWindow(DWORD rootPid) {
  if (rootPid == 0) return nullptr;
  refreshBrowserPidSet(rootPid);
  FindWinCtx ctx{&g_cachedPids, nullptr, nullptr};
  EnumWindows(enumCamoufoxProc, reinterpret_cast<LPARAM>(&ctx));
  return ctx.bestVisible ? ctx.bestVisible : ctx.bestAny;
}

static void detachOwner() {
  if (g_hwnd && g_dockTarget) {
    SetWindowLongPtrW(g_hwnd, GWLP_HWNDPARENT, 0);
    g_dockTarget = nullptr;
  }
}

static void layoutControls(int clientW) {
  if (!g_hwnd || clientW <= 0) return;
  const int pad = 6;
  const int gap = 5;
  const int btnH = 24;
  const int y = (BAR_HEIGHT - 2 - btnH) / 2;

  int right = clientW - pad;
  auto placeRight = [&](HWND ctrl, int w, bool show) {
    if (!show) {
      ShowWindow(ctrl, SW_HIDE);
      return;
    }
    right -= w;
    MoveWindow(ctrl, std::max(pad, right), y, w, btnH, TRUE);
    ShowWindow(ctrl, SW_SHOW);
    right -= gap;
  };

  placeRight(g_revoke, 66, true);
  placeRight(g_revert, 114, g_showRevert);
  placeRight(g_stop, 86, true);
  placeRight(g_returnAll, 84, g_showReturnAll);
  placeRight(g_primary, 134, true);

  int availLeft = std::max(120, right - pad);
  int comboW = std::min(210, std::max(110, availLeft / 2));
  MoveWindow(g_combo, pad, y + 1, comboW, 220, TRUE);
  int statusX = pad + comboW + gap + 2;
  int statusW = std::max(40, right - statusX);
  MoveWindow(g_status, statusX, y, statusW, btnH, TRUE);
}

static void syncDocking() {
  if (!g_hwnd) return;
  bool wantVisible = false;
  DWORD browserPid = 0;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    wantVisible = g_state.visible && !g_state.tabs.empty();
    browserPid = g_state.browserPid;
  }
  if (!wantVisible) {
    if (g_barShown) {
      ShowWindow(g_hwnd, SW_HIDE);
      g_barShown = false;
    }
    detachOwner();
    return;
  }

  if (browserPid == 0) {
    // Fallback when launched standalone without a browserPid: non-topmost top-right.
    detachOwner();
    RECT wa{};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &wa, 0);
    int w = std::min(760, static_cast<int>(wa.right - wa.left - 24));
    int x = wa.right - w - 12;
    int y = wa.top + 12;
    RECT target{x, y, x + w, y + BAR_HEIGHT};
    if (!g_barShown || !EqualRect(&target, &g_lastBarRect)) {
      g_lastBarRect = target;
      SetWindowPos(g_hwnd, HWND_NOTOPMOST, x, y, w, BAR_HEIGHT, SWP_NOACTIVATE | SWP_SHOWWINDOW);
      g_barShown = true;
      RECT rc{};
      GetClientRect(g_hwnd, &rc);
      layoutControls(rc.right - rc.left);
    }
    return;
  }

  HWND target = findCamoufoxWindow(browserPid);
  if (!target || !IsWindow(target) || !IsWindowVisible(target) || IsIconic(target)) {
    if (g_barShown) {
      ShowWindow(g_hwnd, SW_HIDE);
      g_barShown = false;
    }
    if (!target || !IsWindow(target)) detachOwner();
    return;
  }

  bool ownerChanged = (target != g_dockTarget);
  if (ownerChanged) {
    SetWindowLongPtrW(g_hwnd, GWLP_HWNDPARENT, reinterpret_cast<LONG_PTR>(target));
    g_dockTarget = target;
  }

  RECT vis{};
  if (!getVisibleWindowRect(target, &vis)) return;
  HMONITOR mon = MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST);
  MONITORINFO mi = {};
  mi.cbSize = sizeof(mi);
  RECT wa{};
  if (GetMonitorInfoW(mon, &mi)) wa = mi.rcWork;
  else SystemParametersInfoW(SPI_GETWORKAREA, 0, &wa, 0);

  bool zoomed = IsZoomed(target) != FALSE;
  int maxW = static_cast<int>(wa.right - wa.left);
  int x = vis.left;
  int w = static_cast<int>(vis.right - vis.left);
  int y = vis.top - BAR_HEIGHT + 1;

  if (zoomed) {
    // Maximized Camoufox: fuse cleanly along the bottom edge above the taskbar
    // so Firefox tabs, address bar and window buttons are never obscured.
    x = wa.left;
    w = maxW;
    y = wa.bottom - BAR_HEIGHT;
  } else {
    if (w < MIN_BAR_WIDTH) w = std::min(MIN_BAR_WIDTH, maxW);
    if (w > maxW) w = maxW;
    if (x + w > wa.right) x = wa.right - w;
    if (x < wa.left) x = wa.left;
    if (vis.top - BAR_HEIGHT >= wa.top) {
      y = vis.top - BAR_HEIGHT + 1; // Directly fused above Camoufox top border
    } else if (vis.bottom + BAR_HEIGHT <= wa.bottom) {
      y = vis.bottom - 1; // Directly fused below Camoufox bottom border
    } else {
      y = std::min(vis.bottom, wa.bottom) - BAR_HEIGHT;
    }
  }

  RECT nextRect{x, y, x + w, y + BAR_HEIGHT};
  bool rectChanged = !EqualRect(&nextRect, &g_lastBarRect);
  if (!g_barShown || ownerChanged || rectChanged) {
    g_lastBarRect = nextRect;
    // Place immediately above `target` in Z-order (never HWND_TOPMOST!).
    HWND insertAfter = GetWindow(target, GW_HWNDPREV);
    if (!insertAfter || insertAfter == g_hwnd) insertAfter = HWND_TOP;
    UINT flags = SWP_NOACTIVATE | (g_barShown ? 0 : SWP_SHOWWINDOW);
    SetWindowPos(g_hwnd, insertAfter, x, y, w, BAR_HEIGHT, flags);
    g_barShown = true;
    RECT rc{};
    GetClientRect(g_hwnd, &rc);
    layoutControls(rc.right - rc.left);
  }
}

static void applyStateToUi() {
  BarState st;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    st = g_state;
  }
  if (!st.visible || st.tabs.empty()) {
    syncDocking();
    return;
  }

  int selectedIdx = 0;
  int returnCount = 0;
  SendMessageW(g_combo, CB_RESETCONTENT, 0, 0);
  for (size_t i = 0; i < st.tabs.size(); ++i) {
    SendMessageW(g_combo, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(st.tabs[i].label.c_str()));
    if (st.tabs[i].id == st.activeId) selectedIdx = static_cast<int>(i);
    if (st.tabs[i].needsReturn) returnCount++;
  }
  SendMessageW(g_combo, CB_SETCURSEL, selectedIdx, 0);

  const TabState& cur = st.tabs[selectedIdx];
  g_showReturnAll = (returnCount >= 2);
  g_showRevert = st.elevated;
  g_bgKind = st.elevated ? 2 : (cur.needsReturn || returnCount > 0) ? 1 : 0;

  SetWindowTextW(g_status, cur.statusText.c_str());
  SetWindowTextW(g_primary, cur.primaryText.c_str());
  EnableWindow(g_primary, !cur.primaryAction.empty());
  SetWindowTextW(g_returnAll, st.korean ? L"모두 반환" : L"Return all");
  SetWindowTextW(g_stop, st.korean ? L"에이전트 중지" : L"Stop agent");
  EnableWindow(g_stop, cur.stopEnabled);
  SetWindowTextW(g_revert, st.korean ? L"권한 상승 · 해제" : L"Elevated · Revert");
  SetWindowTextW(g_revoke, st.korean ? L"연결 종료" : L"Revoke");

  syncDocking();
  RECT rc{};
  GetClientRect(g_hwnd, &rc);
  layoutControls(rc.right - rc.left);
  InvalidateRect(g_hwnd, nullptr, TRUE);
}

static LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_CREATE: {
      g_font = CreateFontW(-12, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
      g_bgNormal = CreateSolidBrush(RGB(241, 245, 249));
      g_bgHandoff = CreateSolidBrush(RGB(219, 234, 254));
      g_bgElevated = CreateSolidBrush(RGB(254, 243, 199));

      g_combo = CreateWindowExW(0, L"COMBOBOX", L"", WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST | WS_VSCROLL,
        6, 6, 170, 220, hwnd, reinterpret_cast<HMENU>(ID_COMBO), nullptr, nullptr);
      g_status = CreateWindowExW(0, L"STATIC", L"", WS_CHILD | WS_VISIBLE | SS_CENTERIMAGE | SS_ENDELLIPSIS,
        182, 6, 140, 24, hwnd, nullptr, nullptr, nullptr);
      g_primary = CreateWindowExW(0, L"BUTTON", L"Take control", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
        328, 6, 134, 24, hwnd, reinterpret_cast<HMENU>(ID_PRIMARY), nullptr, nullptr);
      g_returnAll = CreateWindowExW(0, L"BUTTON", L"Return all", WS_CHILD | BS_PUSHBUTTON,
        468, 6, 84, 24, hwnd, reinterpret_cast<HMENU>(ID_RETURN_ALL), nullptr, nullptr);
      g_stop = CreateWindowExW(0, L"BUTTON", L"Stop agent", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
        558, 6, 86, 24, hwnd, reinterpret_cast<HMENU>(ID_STOP), nullptr, nullptr);
      g_revert = CreateWindowExW(0, L"BUTTON", L"Elevated · Revert", WS_CHILD | BS_PUSHBUTTON,
        650, 6, 114, 24, hwnd, reinterpret_cast<HMENU>(ID_REVERT), nullptr, nullptr);
      g_revoke = CreateWindowExW(0, L"BUTTON", L"Revoke", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
        770, 6, 66, 24, hwnd, reinterpret_cast<HMENU>(ID_REVOKE), nullptr, nullptr);

      for (HWND c : {g_combo, g_status, g_primary, g_returnAll, g_stop, g_revert, g_revoke}) {
        SendMessageW(c, WM_SETFONT, reinterpret_cast<WPARAM>(g_font), TRUE);
      }
      SetTimer(hwnd, TIMER_DOCK, 33, nullptr);
      return 0;
    }
    case WM_SIZE:
      layoutControls(LOWORD(lp));
      return 0;
    case WM_TIMER:
      if (wp == TIMER_DOCK) syncDocking();
      return 0;
    case WM_CTLCOLORSTATIC: {
      HDC hdc = reinterpret_cast<HDC>(wp);
      SetBkMode(hdc, TRANSPARENT);
      SetTextColor(hdc, g_bgKind == 2 ? RGB(146, 64, 14) : g_bgKind == 1 ? RGB(30, 64, 175) : RGB(31, 41, 55));
      return reinterpret_cast<LRESULT>(g_bgKind == 2 ? g_bgElevated : g_bgKind == 1 ? g_bgHandoff : g_bgNormal);
    }
    case WM_ERASEBKGND: {
      RECT rc;
      GetClientRect(hwnd, &rc);
      FillRect(reinterpret_cast<HDC>(wp), &rc, g_bgKind == 2 ? g_bgElevated : g_bgKind == 1 ? g_bgHandoff : g_bgNormal);
      return 1;
    }
    case WM_STATE_UPDATE:
      applyStateToUi();
      return 0;
    case WM_FLASH_BAR: {
      syncDocking();
      if (g_dockTarget && IsWindow(g_dockTarget)) {
        FLASHWINFO fiTarget{sizeof(fiTarget), g_dockTarget, FLASHW_ALL | FLASHW_TIMERNOFG, 4, 0};
        FlashWindowEx(&fiTarget);
      }
      if (g_barShown) {
        FLASHWINFO fi{sizeof(fi), hwnd, FLASHW_ALL | FLASHW_TIMERNOFG, 4, 0};
        FlashWindowEx(&fi);
      }
      return 0;
    }
    case WM_COMMAND: {
      int id = LOWORD(wp);
      int code = HIWORD(wp);
      if (id == ID_COMBO && code == CBN_SELCHANGE) {
        int sel = static_cast<int>(SendMessageW(g_combo, CB_GETCURSEL, 0, 0));
        {
          std::lock_guard<std::mutex> lock(g_mutex);
          if (sel >= 0 && sel < static_cast<int>(g_state.tabs.size())) {
            g_state.activeId = g_state.tabs[sel].id;
          }
        }
        applyStateToUi();
        return 0;
      }
      std::string activeTab;
      std::string primaryAction;
      {
        std::lock_guard<std::mutex> lock(g_mutex);
        for (const auto& t : g_state.tabs) {
          if (t.id == g_state.activeId || activeTab.empty()) {
            activeTab = wideToUtf8(t.id);
            primaryAction = wideToUtf8(t.primaryAction);
            if (t.id == g_state.activeId) break;
          }
        }
      }
      if (id == ID_PRIMARY && !primaryAction.empty()) emitAction(primaryAction, activeTab);
      else if (id == ID_RETURN_ALL) emitAction("resume-all");
      else if (id == ID_STOP && !activeTab.empty()) emitAction("stop-automation", activeTab);
      else if (id == ID_REVERT) emitAction("revert-standard");
      else if (id == ID_REVOKE) emitAction("revoke");
      return 0;
    }
    case WM_CLOSE:
      KillTimer(hwnd, TIMER_DOCK);
      detachOwner();
      DestroyWindow(hwnd);
      return 0;
    case WM_DESTROY:
      KillTimer(hwnd, TIMER_DOCK);
      detachOwner();
      if (g_font) DeleteObject(g_font);
      if (g_bgNormal) DeleteObject(g_bgNormal);
      if (g_bgHandoff) DeleteObject(g_bgHandoff);
      if (g_bgElevated) DeleteObject(g_bgElevated);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

int wmain() {
  initDwm();
  HINSTANCE hInst = GetModuleHandleW(nullptr);
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = wndProc;
  wc.hInstance = hInst;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.lpszClassName = L"IndependentBrowserControlBar";
  RegisterClassExW(&wc);

  g_hwnd = CreateWindowExW(
    WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
    wc.lpszClassName, L"Camoufox Agent Control Bar",
    WS_POPUP | WS_BORDER,
    0, 0, MIN_BAR_WIDTH, BAR_HEIGHT, nullptr, nullptr, hInst, nullptr);
  if (!g_hwnd) return 1;

  std::thread reader(stdinThread);
  reader.detach();

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return 0;
}
