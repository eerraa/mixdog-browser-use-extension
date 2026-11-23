#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// Compact, non-focus-stealing Win32 Control Bar for Camoufox automation.
// Receives newline-JSON state updates on stdin and emits button clicks on stdout.
// Never touches page content, never steals focus, and exits on stdin EOF.

static constexpr UINT WM_STATE_UPDATE = WM_APP + 1;
static constexpr UINT WM_FLASH_BAR = WM_APP + 2;
static constexpr int ID_COMBO = 101;
static constexpr int ID_PRIMARY = 102;
static constexpr int ID_STOP = 103;
static constexpr int ID_REVERT = 104;
static constexpr int ID_REVOKE = 105;

struct TabState {
  std::wstring id;
  std::wstring label;
  std::wstring statusText;
  std::wstring primaryText;
  std::wstring primaryAction;
  bool stopEnabled = true;
};

struct BarState {
  bool korean = true;
  bool elevated = false;
  bool visible = false;
  std::wstring activeId;
  std::vector<TabState> tabs;
};

static std::mutex g_mutex;
static BarState g_state;
static HWND g_hwnd = nullptr;
static HWND g_combo = nullptr;
static HWND g_status = nullptr;
static HWND g_primary = nullptr;
static HWND g_stop = nullptr;
static HWND g_revert = nullptr;
static HWND g_revoke = nullptr;
static HFONT g_font = nullptr;
static HBRUSH g_bgNormal = nullptr;
static HBRUSH g_bgElevated = nullptr;

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

// Minimal safe JSON string/bool field extractor for our fixed pipe protocol.
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
      if (e == 'n') res.push_back(' ');
      else if (e == 't') res.push_back(' ');
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

static void applyStateToUi() {
  BarState st;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    st = g_state;
  }
  if (!st.visible || st.tabs.empty()) {
    ShowWindow(g_hwnd, SW_HIDE);
    return;
  }

  int selectedIdx = 0;
  SendMessageW(g_combo, CB_RESETCONTENT, 0, 0);
  for (size_t i = 0; i < st.tabs.size(); ++i) {
    SendMessageW(g_combo, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(st.tabs[i].label.c_str()));
    if (st.tabs[i].id == st.activeId) selectedIdx = static_cast<int>(i);
  }
  SendMessageW(g_combo, CB_SETCURSEL, selectedIdx, 0);

  const TabState& cur = st.tabs[selectedIdx];
  std::wstring title = st.elevated
    ? (st.korean ? L"[권한 상승] Camoufox 제어 바" : L"[Elevated] Camoufox Control Bar")
    : (st.korean ? L"Camoufox 에이전트 제어 바" : L"Camoufox Agent Control Bar");
  SetWindowTextW(g_hwnd, title.c_str());
  SetWindowTextW(g_status, cur.statusText.c_str());
  SetWindowTextW(g_primary, cur.primaryText.c_str());
  EnableWindow(g_primary, !cur.primaryAction.empty());
  SetWindowTextW(g_stop, st.korean ? L"에이전트 중지" : L"Stop agent");
  EnableWindow(g_stop, cur.stopEnabled);
  SetWindowTextW(g_revert, st.korean ? L"권한 상승 · 해제" : L"Elevated · Revert");
  ShowWindow(g_revert, st.elevated ? SW_SHOW : SW_HIDE);
  SetWindowTextW(g_revoke, st.korean ? L"연결 종료" : L"Revoke");

  InvalidateRect(g_hwnd, nullptr, TRUE);
  if (!IsWindowVisible(g_hwnd)) {
    ShowWindow(g_hwnd, SW_SHOWNOACTIVATE);
  }
}

static LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_CREATE: {
      g_font = CreateFontW(-13, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
      g_bgNormal = CreateSolidBrush(RGB(245, 247, 250));
      g_bgElevated = CreateSolidBrush(RGB(254, 243, 199));

      g_combo = CreateWindowExW(0, L"COMBOBOX", L"", WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST | WS_VSCROLL,
        8, 8, 165, 180, hwnd, reinterpret_cast<HMENU>(ID_COMBO), nullptr, nullptr);
      g_status = CreateWindowExW(0, L"STATIC", L"", WS_CHILD | WS_VISIBLE | SS_CENTERIMAGE | SS_ENDELLIPSIS,
        180, 8, 180, 26, hwnd, nullptr, nullptr, nullptr);
      g_primary = CreateWindowExW(0, L"BUTTON", L"Take control", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
        366, 7, 118, 28, hwnd, reinterpret_cast<HMENU>(ID_PRIMARY), nullptr, nullptr);
      g_stop = CreateWindowExW(0, L"BUTTON", L"Stop agent", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
        490, 7, 94, 28, hwnd, reinterpret_cast<HMENU>(ID_STOP), nullptr, nullptr);
      g_revert = CreateWindowExW(0, L"BUTTON", L"Elevated · Revert", WS_CHILD | BS_PUSHBUTTON,
        590, 7, 126, 28, hwnd, reinterpret_cast<HMENU>(ID_REVERT), nullptr, nullptr);
      g_revoke = CreateWindowExW(0, L"BUTTON", L"Revoke", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
        722, 7, 74, 28, hwnd, reinterpret_cast<HMENU>(ID_REVOKE), nullptr, nullptr);

      for (HWND c : {g_combo, g_status, g_primary, g_stop, g_revert, g_revoke}) {
        SendMessageW(c, WM_SETFONT, reinterpret_cast<WPARAM>(g_font), TRUE);
      }
      return 0;
    }
    case WM_CTLCOLORSTATIC: {
      bool elev = false;
      { std::lock_guard<std::mutex> lock(g_mutex); elev = g_state.elevated; }
      HDC hdc = reinterpret_cast<HDC>(wp);
      SetBkMode(hdc, TRANSPARENT);
      SetTextColor(hdc, elev ? RGB(146, 64, 14) : RGB(31, 41, 55));
      return reinterpret_cast<LRESULT>(elev ? g_bgElevated : g_bgNormal);
    }
    case WM_ERASEBKGND: {
      bool elev = false;
      { std::lock_guard<std::mutex> lock(g_mutex); elev = g_state.elevated; }
      RECT rc;
      GetClientRect(hwnd, &rc);
      FillRect(reinterpret_cast<HDC>(wp), &rc, elev ? g_bgElevated : g_bgNormal);
      return 1;
    }
    case WM_STATE_UPDATE:
      applyStateToUi();
      return 0;
    case WM_FLASH_BAR: {
      FLASHWINFO fi{sizeof(fi), hwnd, FLASHW_ALL | FLASHW_TIMERNOFG, 4, 0};
      FlashWindowEx(&fi);
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
      else if (id == ID_STOP && !activeTab.empty()) emitAction("stop-automation", activeTab);
      else if (id == ID_REVERT) emitAction("revert-standard");
      else if (id == ID_REVOKE) emitAction("revoke");
      return 0;
    }
    case WM_CLOSE:
      DestroyWindow(hwnd);
      return 0;
    case WM_DESTROY:
      if (g_font) DeleteObject(g_font);
      if (g_bgNormal) DeleteObject(g_bgNormal);
      if (g_bgElevated) DeleteObject(g_bgElevated);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

int wmain() {
  HINSTANCE hInst = GetModuleHandleW(nullptr);
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = wndProc;
  wc.hInstance = hInst;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.lpszClassName = L"IndependentBrowserControlBar";
  RegisterClassExW(&wc);

  int screenW = GetSystemMetrics(SM_CXSCREEN);
  int barW = 812;
  int barH = 74;
  int x = screenW > barW + 24 ? screenW - barW - 24 : 12;
  int y = 16;

  g_hwnd = CreateWindowExW(
    WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
    wc.lpszClassName, L"Camoufox Agent Control Bar",
    WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
    x, y, barW, barH, nullptr, nullptr, hInst, nullptr);
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
