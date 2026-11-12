// Test the production scan against current and historical Win32 key-state bits,
// without injecting keys or requiring an interactive foreground window.
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cassert>
static SHORT keyStates[256] = {};
static int samples = 0;
static SHORT fixtureAsyncKeyState(int key) { ++samples; return keyStates[key]; }
static HWND owner = reinterpret_cast<HWND>(static_cast<uintptr_t>(0x1234));
static bool validOwner = true, correctForeground = true, objectQuery = true, activeDesktop = true, processAccess = true;
static HWND fixtureForeground() { return correctForeground ? owner : nullptr; }
static BOOL fixtureWindow(HWND value) { return validOwner && value == owner; }
static DWORD fixtureOwnerPid(HWND, DWORD* pid) { *pid = GetCurrentProcessId(); return GetCurrentThreadId(); }
static BOOL fixtureObjectInfo(HANDLE, int, void* value, DWORD, DWORD*) { *static_cast<BOOL*>(value) = activeDesktop; return objectQuery; }
static HANDLE fixtureOpenProcess(DWORD access, BOOL inherit, DWORD pid) { return processAccess ? OpenProcess(access, inherit, pid) : nullptr; }
#define GetAsyncKeyState fixtureAsyncKeyState
#define GetForegroundWindow fixtureForeground
#define IsWindow fixtureWindow
#define GetWindowThreadProcessId fixtureOwnerPid
#define GetUserObjectInformationW fixtureObjectInfo
#define OpenProcess fixtureOpenProcess
#define wmain consentMain
#include "../../native/consent.cpp"
#undef wmain
#undef GetAsyncKeyState

int wmain() {
  assert(allInputReleased());
  assert(samples == 254);
  for (const int key : {VK_LBUTTON, VK_RBUTTON, VK_MBUTTON, VK_XBUTTON1, VK_XBUTTON2, VK_LCONTROL, VK_RMENU, 0x41, VK_F24}) {
    keyStates[key] = 1; // "Pressed since last query" is not a held key.
    assert(allInputReleased());
    keyStates[key] = static_cast<SHORT>(0x8000);
    assert(!allInputReleased());
    keyStates[key] = static_cast<SHORT>(0x8001);
    assert(!allInputReleased());
    keyStates[key] = 0;
  }
  assert(!inputContext(nullptr, 0, nullptr));
  const HDESK desktop = reinterpret_cast<HDESK>(static_cast<uintptr_t>(0x5678));
  assert(inputContext(owner, GetCurrentProcessId(), desktop));
  correctForeground = false; assert(!inputContext(owner, GetCurrentProcessId(), desktop)); correctForeground = true;
  validOwner = false; assert(!inputContext(owner, GetCurrentProcessId(), desktop)); validOwner = true;
  objectQuery = false; assert(!inputContext(owner, GetCurrentProcessId(), desktop)); objectQuery = true;
  activeDesktop = false; assert(!inputContext(owner, GetCurrentProcessId(), desktop)); activeDesktop = true;
  processAccess = false; assert(!inputContext(owner, GetCurrentProcessId(), desktop)); processAccess = true;
  assert(!inputContext(owner, GetCurrentProcessId() + 1, desktop));
  std::puts("INPUT_STATE_BITS_PASSED");
  return 0;
}
