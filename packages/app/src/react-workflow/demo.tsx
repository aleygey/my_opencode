/** @jsxImportSource react */
import { createRoot } from "react-dom/client"
import "@opencode-ai/ui/styles/tailwind"
import { WorkflowApp, type WorkflowAppProps } from "./app"

const mockProps: WorkflowAppProps = {
  root: "session-root-001",
  title: "Fancy hello C on target via ttyS0",
  status: "running",
  env: "ARM Linux",
  pick: "node-003",
  model: "GPT-5.4",
  models: ["GPT-5.4", "GPT-5.4-turbo", "Claude-3.5-Sonnet", "Claude-3-Opus", "Gemini-Pro"],
  workspace: "/home/user/projects/embedded-firmware/arm-hello",
  nodes: [],
  chains: [
    {
      id: "chain-build",
      label: "Build & Flash",
      nodes: [
        { id: "node-001", title: "Initialize Environment", type: "coding", status: "completed", session: "session-001" },
        { id: "node-002", title: "Create fancy hello C source", type: "coding", status: "completed", session: "session-002" },
        { id: "node-003", title: "Compile the C program", type: "build-flash", status: "running", session: "session-003" },
      ],
    },
    {
      id: "chain-deploy",
      label: "Deploy & Verify",
      nodes: [
        { id: "node-004", title: "Transfer and run over ttyS0", type: "debug", status: "pending", session: "session-004" },
        { id: "node-005", title: "Verify Execution Logs", type: "debug", status: "pending", session: "session-005" },
      ],
    },
  ],
  details: {
    "node-001": {
      id: "node-001",
      title: "Initialize Environment",
      type: "coding",
      status: "completed",
      result: "Success",
      model: "claude-sonnet-4-6",
      attempt: "1/3",
      actions: "8/50",
      sessionId: "session-001",
      pendingCommands: 0,
      lastControl: "none",
      lastPull: "#12",
      lastUpdate: "#14",
      stateJson: { target: "ARM Linux x86", arch: "aarch64" },
    },
    "node-002": {
      id: "node-002",
      title: "Create fancy hello C source",
      type: "coding",
      status: "completed",
      result: "completed",
      model: "GPT-5.4-turbo",
      attempt: "1/3",
      actions: "15/30",
      duration: "2.9s",
      sessionId: "session-002",
      pendingCommands: 0,
      lastControl: "none",
      lastPull: "#31",
      lastUpdate: "#33",
      stateJson: { file: "hello_fancy.c", lines: 48 },
    },
    "node-003": {
      id: "node-003",
      title: "Compile the C program",
      type: "build-flash",
      status: "running",
      result: "in progress",
      model: "GPT-5.4",
      attempt: "2/3",
      actions: "15/30",
      duration: "3.2s",
      sessionId: "session-003",
      pendingCommands: 2,
      lastControl: "resume",
      lastPull: "#61",
      lastUpdate: "#63",
      stateJson: {
        phase: "compile",
        target: "ARM (Linux)",
        toolchain: "gcc-arm-linux-gnueabihf",
        output_file: "hello_fancy",
        binary_size: "6.2 KB",
        status: "in_progress",
        progress: 75,
      },
      executionLog: [
        "[1] Starting cross-compilation process...",
        "[2] Target architecture: ARM (Linux)",
        "[3] Toolchain: gcc-arm-linux-gnueabihf",
        "[4] Compiler flags: -O2 -Wall -Wextra",
        "[5] Compiling hello_fancy.c...",
        "[6] Linking binary...",
        "[7] Binary size: 8.4 KB",
        "[8] Stripping debug symbols...",
        "[9] Final binary: 6.2 KB",
        "[10] Compilation successful",
      ],
    },
    "node-004": {
      id: "node-004",
      title: "Transfer and run over ttyS0",
      type: "debug",
      status: "pending",
      result: "pending",
      model: "GPT-5.4",
      attempt: "0/3",
      actions: "0/30",
      duration: "0.0s",
      sessionId: "session-004",
      pendingCommands: 0,
      lastControl: "none",
      lastPull: "none",
      lastUpdate: "none",
      stateJson: {},
    },
    "node-005": {
      id: "node-005",
      title: "Verify Execution Logs",
      type: "debug",
      status: "pending",
      result: "pending",
      model: "GPT-5.4",
      attempt: "0/3",
      actions: "0/30",
      duration: "0.0s",
      sessionId: "session-005",
      pendingCommands: 0,
      lastControl: "none",
      lastPull: "none",
      lastUpdate: "none",
      stateJson: {},
    },
  },
  flow: {
    goal: "Create a fancy hello world program in C and deploy it to an ARM Linux target device via serial connection (ttyS0)",
    phase: "Compilation",
    overallStatus: "running",
  },
  agents: [
    { name: "Setup Agent", model: "GPT-5.4-turbo", role: "Environment initialization and configuration" },
    { name: "Code Generation Agent", model: "GPT-5.4-turbo", role: "Source code creation and modification" },
    { name: "Build Agent", model: "GPT-5.4", role: "Cross-compilation and binary generation" },
    { name: "Deployment Agent", model: "GPT-5.4", role: "Binary transfer and execution" },
    { name: "Verification Agent", model: "GPT-5.4", role: "Testing and validation" },
  ],
  chats: {
    "session-root-001": [
      { id: "m0", role: "system" as const, content: "Workflow execution initialized. Target environment: ARM Linux (ttyS0).", timestamp: "14:20:00" },
      { id: "m1", role: "user" as const, content: "Create a fancy hello world program in C and deploy it to the target device via serial.", timestamp: "14:20:15" },
      { id: "m2", role: "assistant" as const, content: "I'll create a C program with enhanced output formatting and compile it for ARM architecture. Then I'll transfer and execute it on your target device.\n\n## Plan\n\n1. **Initialize** cross-compilation environment\n2. **Write** `hello_fancy.c` with ANSI color support\n3. **Compile** using `gcc-arm-linux-gnueabihf`\n4. **Transfer** binary via serial (`ttyS0`)\n5. **Verify** execution on target", timestamp: "14:20:20" },
      // Agent switch
      { id: "m2a", role: "assistant" as const, content: "", timestamp: "14:20:22", agent: { name: "Code Generation Agent" } },
      // Tool call
      { id: "m3", role: "tool" as const, content: "Created hello_fancy.c with ANSI color support and animated text effects.", timestamp: "14:21:30", toolCall: { name: "write_file", status: "completed" as const, duration: "0.8s" } },
      // Patch — code changes
      { id: "m3a", role: "assistant" as const, content: "2 files changed", timestamp: "14:21:32", patch: { hash: "abc123", files: ["src/hello_fancy.c", "Makefile"] } },
      // Reasoning
      { id: "m3b", role: "assistant" as const, content: "", timestamp: "14:21:35", reasoning: { text: "The user wants ANSI colors and animation. I should use escape codes for bold, color, and cursor movement. The Makefile needs cross-compiler flags for ARM target. Let me check if -static linking is needed for the target environment.", time: { start: 1700000000, end: 1700000003 } } },
      { id: "m4", role: "assistant" as const, content: "Source file created. Now setting up cross-compilation...", timestamp: "14:22:00" },
      // Subtask
      { id: "m4a", role: "assistant" as const, content: "", timestamp: "14:22:05", subtask: { description: "Cross-compile for ARM target", agent: "Build Agent", prompt: "Compile hello_fancy.c for ARM Linux using gcc-arm-linux-gnueabihf" } },
      // Step finish
      { id: "m4b", role: "assistant" as const, content: "", timestamp: "14:22:10", stepFinish: { reason: "Code generation complete", cost: 0.0042, tokens: { input: 1250, output: 860 } } },
      // Sand table card
      {
        id: "m4c", role: "assistant" as const, content: "", timestamp: "14:22:15",
        sandTable: {
          id: "st-001",
          topic: "Deployment strategy for ARM target",
          rounds: 2,
          status: "approved",
          messages: [
            { role: "planner", model: "GPT-5.4", content: "## Deployment Plan\n\n1. Verify serial connection at /dev/ttyS0 (115200 baud)\n2. Use `sx` (XMODEM) to transfer binary\n3. Set execute permission via `chmod +x`\n4. Run and capture stdout\n5. Verify output contains expected ANSI sequences", round: 1 },
            { role: "evaluator", model: "Claude-3.5-Sonnet", content: "REVISE: The plan should include a fallback for when XMODEM is not available on the target. Consider using `cat` with base64 encoding as alternative. Also add a timeout for the serial connection check.", round: 1 },
            { role: "planner", model: "GPT-5.4", content: "## Revised Deployment Plan\n\n1. Probe serial at /dev/ttyS0 with 3s timeout\n2. Check for `sx` availability; fallback to base64+cat transfer\n3. Transfer binary (~6KB)\n4. `chmod +x ./hello_fancy && ./hello_fancy`\n5. Capture and validate output (expect ANSI escape codes)\n6. Cleanup: remove binary from target", round: 2 },
            { role: "evaluator", model: "Claude-3.5-Sonnet", content: "APPROVE: The revised plan covers the fallback scenario and includes proper cleanup. The 3s timeout is reasonable for serial probe.", round: 2 },
          ],
          finalPlan: "## Revised Deployment Plan\n\n1. Probe serial at /dev/ttyS0 with 3s timeout\n2. Check for `sx` availability; fallback to base64+cat transfer\n3. Transfer binary (~6KB)\n4. `chmod +x ./hello_fancy && ./hello_fancy`\n5. Capture and validate output (expect ANSI escape codes)\n6. Cleanup: remove binary from target",
        } as any,
      },
      // Retry
      { id: "m4d", role: "assistant" as const, content: "", timestamp: "14:22:30", retry: { attempt: 2, error: "Connection timeout on /dev/ttyS0 — retrying with different baud rate" } },
      // Running tool
      { id: "m5", role: "tool" as const, content: "Compilation in progress using cross-compiler for ARM target...", timestamp: "14:23:35", toolCall: { name: "exec_command", status: "running" as const, progress: 65 } },
      // Question dialog
      {
        id: "m6", role: "assistant" as const, content: "", timestamp: "14:24:00",
        question: {
          id: "q-001",
          sessionID: "session-root-001",
          questions: [
            {
              question: "The target device has limited storage. Which optimization level should I use for compilation?",
              header: "Compiler Optimization",
              options: [
                { label: "-O2", description: "Balanced optimization — good performance with reasonable binary size" },
                { label: "-Os", description: "Optimize for size — smallest binary, slightly slower" },
                { label: "-O3", description: "Maximum optimization — fastest execution, larger binary" },
              ],
              multiple: false,
              custom: true,
            },
          ],
        } as any,
      },
      // Permission dialog
      {
        id: "m7", role: "assistant" as const, content: "", timestamp: "14:24:15",
        permission: {
          id: "p-001",
          sessionID: "session-root-001",
          permission: "bash",
          patterns: ["/dev/ttyS0"],
          metadata: { command: "minicom -D /dev/ttyS0 -b 115200" },
        } as any,
      },
      // File attachment
      { id: "m8", role: "assistant" as const, content: "", timestamp: "14:24:30", file: { mime: "text/x-c", filename: "hello_fancy.c", url: "#" } },
    ],
    "session-003": [
      { id: "m0", role: "system" as const, content: "Session initialized. Ready to execute workflow.", timestamp: "14:20:00" },
      { id: "m1", role: "user" as const, content: "Create a hello world program in C with fancy formatting.", timestamp: "14:20:15" },
      { id: "m2", role: "assistant" as const, content: "I'll create a C program with ANSI color support and animated text effects. Let me start by writing the source code.", timestamp: "14:20:18" },
      { id: "m3", role: "tool" as const, content: "File created: hello_fancy.c\nAdded ANSI escape codes for colors\nAdded text animation functions", timestamp: "14:20:25", toolCall: { name: "write_file", status: "completed" as const, duration: "0.4s" } },
      { id: "m4", role: "assistant" as const, content: "Source code created successfully. Now compiling for ARM architecture using gcc-arm-linux-gnueabihf...", timestamp: "14:20:30" },
      { id: "m5", role: "tool" as const, content: "Compilation started\nTarget: ARM Linux\nToolchain: gcc-arm-linux-gnueabihf\nOptimization: -O2", timestamp: "14:20:32", toolCall: { name: "exec_command", status: "running" as const, progress: 45 } },
    ],
  },
  tasks: [
    {
      id: "session-root-001",
      title: "Fancy hello C on target via ttyS0",
      status: "running" as const,
      nodes: [
        { id: "node-001", title: "Initialize Environment", type: "coding" as const, status: "completed" as const, session: "session-001" },
        { id: "node-002", title: "Create fancy hello C source", type: "coding" as const, status: "completed" as const, session: "session-002" },
        { id: "node-003", title: "Compile the C program", type: "build-flash" as const, status: "running" as const, session: "session-003" },
      ],
      duration: "4m 12s",
    },
    {
      id: "task-prev-001",
      title: "LED blink firmware for STM32",
      status: "completed" as const,
      nodes: [
        { id: "prev-001", title: "Generate blink.c", type: "coding" as const, status: "completed" as const, session: "s-prev-001" },
        { id: "prev-002", title: "Cross-compile for Cortex-M4", type: "build-flash" as const, status: "completed" as const, session: "s-prev-002" },
      ],
      duration: "1m 48s",
    },
    {
      id: "task-prev-002",
      title: "UART driver integration test",
      status: "failed" as const,
      nodes: [
        { id: "prev-003", title: "Build test harness", type: "coding" as const, status: "completed" as const, session: "s-prev-003" },
        { id: "prev-004", title: "Run UART loopback", type: "debug" as const, status: "failed" as const, session: "s-prev-004" },
      ],
      duration: "3m 05s",
    },
  ],
  onSession: (node) => console.log("open session", node),
  onModel: () => console.log("open model picker"),
  onModelChange: (model) => console.log("model changed to", model),
  onWorkspaceClick: () => console.log("workspace click"),
  onDeleteTask: (id) => console.log("delete task", id),
  onRun: (node) => console.log("run", node),
  onRestart: (node) => console.log("restart", node),
  onStop: (node) => console.log("stop", node),
  onPause: (node) => console.log("pause", node),
  onStopMaster: () => console.log("stop master only"),
  onSend: (text, node) => console.log("send", text, node),
  onQuestionReply: (id, answers) => console.log("question reply", id, answers),
  onQuestionReject: (id) => console.log("question reject", id),
  onPermissionReply: (id, reply, msg) => console.log("permission reply", id, reply, msg),
}

const root = document.getElementById("root")!
createRoot(root).render(<WorkflowApp {...mockProps} />)
