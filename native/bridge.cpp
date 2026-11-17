#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>
#include <cwchar>
#include <string>
#include <vector>

// MinGW-w64 8.1 headers predate this Windows 10 attribute:
// ProcThreadAttributeValue(ProcThreadAttributeJobList = 13, FALSE, TRUE, FALSE).
#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#define PROC_THREAD_ATTRIBUTE_JOB_LIST 0x0002000D
#endif

// The launcher owns only the process tree it creates. A non-inherited Windows
// job closes every descendant if the launcher is terminated by the MCP host.
// It never scans, signals, or changes another process/session.
static int failed(const wchar_t* operation) {
  std::fwprintf(stderr, L"Independent Browser launcher: %ls failed (%lu)\n", operation, GetLastError());
  return 90;
}

// The package root is the final path of this executable, links resolved. A
// stable folder that is a junction to a versioned install is resolved once
// here, so this process tree never loads files of a later install.
static bool packageRoot(std::wstring& root) {
  std::vector<wchar_t> buffer(32768);
  DWORD size = GetModuleFileNameW(nullptr, buffer.data(), 32768);
  if (!size || size >= 32768) return false;
  const HANDLE file = CreateFileW(buffer.data(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, 0, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  size = GetFinalPathNameByHandleW(file, buffer.data(), 32768, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  CloseHandle(file);
  if (!size || size >= 32768) return false;
  root.assign(buffer.data(), size);
  if (!root.compare(0, 8, L"\\\\?\\UNC\\")) root = L"\\\\" + root.substr(8);
  else if (!root.compare(0, 4, L"\\\\?\\") && root.size() - 4 < MAX_PATH) root.erase(0, 4);
  root.resize(root.find_last_of(L'\\'));
  root.resize(root.find_last_of(L'\\')); // <plugin>\bin\bridge.exe
  return true;
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 64;
  const bool browser = !std::wcscmp(argv[1], L"--browser");
  const wchar_t* script = browser ? L"companion.cjs"
    : !std::wcscmp(argv[1], L"--mcp") ? L"mcp.cjs"
    : !std::wcscmp(argv[1], L"--hook") ? L"hook.cjs" : nullptr;
  if (!script) return 64;
  std::wstring root;
  if (!packageRoot(root)) return failed(L"package root");
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
  // The child is created inside the job. Assigning it after CreateProcess left
  // a window in which a host terminating this launcher orphaned a suspended
  // child that still held the host's stdio pipes.
  SIZE_T attributeSize = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &attributeSize);
  std::vector<BYTE> attributes(attributeSize);
  startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0, &attributeSize)) {
    const int result = failed(L"process attribute list");
    for (HANDLE handle : handles) CloseHandle(handle);
    CloseHandle(job);
    return result;
  }
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      handles, sizeof(handles), nullptr, nullptr)
    || !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
      &job, sizeof(job), nullptr, nullptr)) {
    const int result = failed(L"child handle and job attributes");
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    for (HANDLE handle : handles) CloseHandle(handle);
    CloseHandle(job);
    return result;
  }
  PROCESS_INFORMATION child{};
  const BOOL created = CreateProcessW(runtime.c_str(), command.data(), nullptr, nullptr, TRUE,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
    nullptr, root.c_str(), &startup.StartupInfo, &child);
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  for (HANDLE handle : handles) CloseHandle(handle);
  if (!created) { const int result = failed(L"CreateProcess"); CloseHandle(job); return result; }
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
