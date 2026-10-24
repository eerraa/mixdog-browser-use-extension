#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>
#include <cwchar>
#include <string>
#include <vector>

// The launcher owns only the process tree it creates. A non-inherited Windows
// job closes every descendant if the launcher is terminated by the MCP host.
// It never scans, signals, or changes another process/session.
static int failed(const wchar_t* operation) {
  std::fwprintf(stderr, L"Independent Browser launcher: %ls failed (%lu)\n", operation, GetLastError());
  return 90;
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 64;
  const bool browser = !std::wcscmp(argv[1], L"--browser");
  const wchar_t* script = browser ? L"companion.cjs"
    : !std::wcscmp(argv[1], L"--mcp") ? L"mcp.cjs"
    : !std::wcscmp(argv[1], L"--hook") ? L"hook.cjs" : nullptr;
  if (!script) return 64;
  wchar_t executable[32768];
  const DWORD size = GetModuleFileNameW(nullptr, executable, 32768);
  if (!size || size >= 32768) return failed(L"GetModuleFileName");
  std::wstring root(executable, size);
  root.resize(root.find_last_of(L"\\/"));
  root.resize(root.find_last_of(L"\\/")); // <plugin>/bin/bridge.exe
  const std::wstring runtime = root + L"\\runtime\\electron.exe";
  const std::wstring entry = root + L"\\app\\" + script;
  std::wstring command = L"\"" + runtime + L"\" \"" + entry + L"\"";
  // These changes are private to this launcher/child, never persisted settings.
  if (!SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", browser ? nullptr : L"1")
    || !SetEnvironmentVariableW(L"NODE_OPTIONS", nullptr)
    || !SetEnvironmentVariableW(L"NODE_PATH", nullptr)) return failed(L"child environment");

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) return failed(L"CreateJobObject");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    const int result = failed(L"SetInformationJobObject");
    CloseHandle(job);
    return result;
  }
  HANDLE handles[3]{};
  const DWORD slots[3] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  for (int i = 0; i < 3; ++i) {
    if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(slots[i]), GetCurrentProcess(),
      &handles[i], 0, TRUE, DUPLICATE_SAME_ACCESS)) {
      const int result = failed(L"DuplicateHandle");
      for (HANDLE handle : handles) if (handle) CloseHandle(handle);
      CloseHandle(job);
      return result;
    }
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = handles[0];
  startup.StartupInfo.hStdOutput = handles[1];
  startup.StartupInfo.hStdError = handles[2];
  SIZE_T attributeSize = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
  std::vector<BYTE> attributes(attributeSize);
  startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributeSize)
    || !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      handles, sizeof(handles), nullptr, nullptr)) {
    const int result = failed(L"standard handle allowlist");
    for (HANDLE handle : handles) CloseHandle(handle);
    CloseHandle(job);
    return result;
  }
  PROCESS_INFORMATION child{};
  const BOOL created = CreateProcessW(runtime.c_str(), command.data(), nullptr, nullptr, TRUE,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
    nullptr, root.c_str(), &startup.StartupInfo, &child);
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  for (HANDLE handle : handles) CloseHandle(handle);
  if (!created) { const int result = failed(L"CreateProcess"); CloseHandle(job); return result; }
  if (!AssignProcessToJobObject(job, child.hProcess)) {
    const int result = failed(L"AssignProcessToJobObject");
    TerminateProcess(child.hProcess, 90);
    CloseHandle(child.hThread); CloseHandle(child.hProcess); CloseHandle(job);
    return result;
  }
  ResumeThread(child.hThread);
  CloseHandle(child.hThread);
  WaitForSingleObject(child.hProcess, INFINITE);
  DWORD exitCode = 1;
  GetExitCodeProcess(child.hProcess, &exitCode);
  // Root exit alone is not a receipt for Chromium's utility/renderer children.
  TerminateJobObject(job, exitCode);
  const ULONGLONG deadline = GetTickCount64() + 5000;
  bool empty = false;
  do {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
      &accounting, sizeof(accounting), nullptr)) break;
    if (!accounting.ActiveProcesses) { empty = true; break; }
    Sleep(10);
  } while (GetTickCount64() < deadline);
  CloseHandle(child.hProcess);
  CloseHandle(job);
  if (!empty) {
    std::fputs("Independent Browser launcher: owned job teardown was not confirmed\n", stderr);
    return 91;
  }
  return static_cast<int>(exitCode);
}
