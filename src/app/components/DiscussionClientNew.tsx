//src/app/components/DiscussionClientNew.tsx

"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClientComponentClient } from "@supabase/auth-helpers-nextjs";
import { useDiscussionAgora } from "../hooks/useDiscussionAgora";
import { IAgoraRTCRemoteUser } from "agora-rtc-sdk-ng";
import { useMediaRecorder } from "../hooks/useMediaRecorder";
import { useCountdown } from "../hooks/useCountdown";
import { CountdownDisplay } from "../components/CountdownDisplay";

// 定义字幕记录的类型
interface CaptionEntry {
  speaker: string;
  text: string;
  timestamp: number;
  uid: string;
}

// Web Speech API 类型
interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList;
  resultIndex: number;
  readonly NONE: number;
  readonly SERVICE: number;
  readonly NETWORK: number;
  readonly NO_SPEECH: number;
  readonly NO_MICROPHONE: number;
  readonly AUDIO_CAPTURE: number;
  readonly ABORTED: number;
}

interface SpeechRecognitionError {
  error: string;
  message?: string;
}

interface SpeechRecognitionInstance {
  start: () => void;
  stop: () => void;
  abort: () => void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (event: SpeechRecognitionEvent) => void;
  onerror: (event: SpeechRecognitionError) => void;
  onend: () => void;
}

// SpeechRecognition 构造函数接口
interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

// 精简标点符号函数，只保留英语处理
function addPunctuation(text: string): string {
  // 如果文本已经以标点符号结尾，则直接返回
  if (/[.!?]$/.test(text)) {
    return text;
  }

  // 英文标点规则
  if (/^(what|who|when|where|why|how|which)/i.test(text)) {
    return `${text}?`;
  } else if (
    /^(can|could|would|will|shall|should|may|might|must)/i.test(text)
  ) {
    return `${text}?`;
  } else if (/^(oh|wow|ah|ouch|hey|hi|hello|damn|no|yes)/i.test(text)) {
    return `${text}!`;
  } else {
    return `${text}.`;
  }
}

// 用于使用 useSearchParams 的组件
function DiscussionClientContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClientComponentClient();

  const channel = searchParams.get("channel");
  const uid = searchParams.get("uid");
  const displayName = searchParams.get("displayName");
  const autoJoin = true; // Always auto-join

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const hasStartedDiscussionRef = useRef(false);

  const [allReady, setAllReady] = useState(false);

  // Web Speech API 相关状态
  const [recognition, setRecognition] =
    useState<SpeechRecognitionInstance | null>(null);
  const [captions, setCaptions] = useState<CaptionEntry[]>([]);

  // Initialize Agora client
  const {
    localVideoTrack,
    remoteUsers,
    leave: leaveChannel,
    join: joinChannel,
    ready: agoraReady,
  } = useDiscussionAgora();

  const { startRecording, stopRecording, recording } = useMediaRecorder(
    async (blob, startTime) => {
      const formData = new FormData();
      formData.append("audio", blob, "audio.webm");
      formData.append("speaker", displayName || "Unknown");

      const res = await fetch("/api/whisper-transcript/stt", {
        method: "POST",
        body: formData,
      });

      const result = await res.json();
      if (result.transcript) {
        console.log("📝 Transcribed:", result.transcript);
      }
      if (!startTime) {
        console.warn("⚠️ userStartAt is missing, skipping transcript submit");
        return;
      }
      console.log("🛰️ Submitting transcript:", {
        session_id: sessionId,
        user_id: uid,
        transcript: result.transcript,
        startAt: new Date(startTime).toISOString(),
      });
      const submitRes = await fetch("/api/whisper-transcript/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: sessionId,
          user_id: uid,
          transcript: result.transcript, // transcript 是带 start/end/speaker 的结构
          startAt: new Date(startTime).toISOString(), // 用来对齐时间线
        }),
      });

      if (!submitRes.ok) {
        const errorText = await submitRes.text();
        console.error(
          "❌ Failed to submit transcript:",
          submitRes.status,
          errorText
        );
      } else {
        console.log("✅ Transcript submitted to Supabase");
      }
    }
  );

  // useCountdown hook
  const [discussionStartTime, setDiscussionStartTime] = useState<string | null>(
    null
  );
  async function stopCloudRecording(
    sessionId: string,
    cname: string,
    uid: string,
    mode: "mix" | "individual"
  ) {
    try {
      const res = await fetch("/api/agora/stop-recording", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, cname, uid, mode }),
      });
      const result = await res.json();
      if (!res.ok) {
        console.warn(`❌ Failed to stop ${mode} recording:`, result);
      } else {
        console.log(`✅ ${mode} recording stopped`);
      }
    } catch (err) {
      console.error(`❌ Error stopping ${mode} recording:`, err);
    }
  }

  const { timeLeft } = useCountdown({
    startTime: discussionStartTime,
    durationSeconds: 90,
    onExpire: async () => {
      console.log("⏰ 倒计时结束，自动停止录音并提交 transcript");
      if (recording) {
        await stopRecording(); // 自动触发音频停止
        hasStartedDiscussionRef.current = true;

        try {
          if (sessionId && channel) {
            await Promise.all([
              stopCloudRecording(sessionId, channel, "123", "mix"),
              stopCloudRecording(sessionId, channel, "456", "individual"),
            ]);
          }
        } catch (error) {
          console.error("❌ Error calling stop-recording API:", error);
        }
        await leaveChannel();
        router.push(
          `/evaluation-waiting?session_id=${sessionId}&user_id=${uid}`
        );
      }
    },
  });

  const [participants, setParticipants] = useState<
    Array<{
      user_id: string;
      display_name: string;
      is_ai: boolean;
      agora_uid?: string;
    }>
  >([]);

  // Handle leaving the discussion
  const handleLeave = async () => {
    try {
      if (!sessionId || !uid) return;

      // 停止语音识别
      if (recognition) {
        recognition.stop();
      }

      // Leave Agora channel
      await leaveChannel();

      // Navigate back to home
      router.replace("/");
    } catch (err) {
      console.error("Error leaving discussion:", err);
      setError("Failed to leave discussion properly");
    }
  };

  // 使用 Web Speech API 开始字幕识别
  const startCaptions = () => {
    if (!displayName) return;

    try {
      // 检查浏览器支持
      if (
        !("webkitSpeechRecognition" in window) &&
        !("SpeechRecognition" in window)
      ) {
        alert(
          "Your browser doesn't support speech recognition. Please use Chrome, Edge or Safari."
        );
        return;
      }

      // 创建语音识别实例
      const SpeechRecognition =
        (
          window as unknown as {
            SpeechRecognition: SpeechRecognitionConstructor;
          }
        ).SpeechRecognition ||
        (
          window as unknown as {
            webkitSpeechRecognition: SpeechRecognitionConstructor;
          }
        ).webkitSpeechRecognition;
      const recognitionInstance = new SpeechRecognition();

      // 配置语音识别
      recognitionInstance.continuous = true; // 持续识别
      recognitionInstance.interimResults = true; // 返回中间结果
      recognitionInstance.lang = "en-US"; // 固定为英语

      // 处理识别结果
      recognitionInstance.onresult = (event: SpeechRecognitionEvent) => {
        const last = event.results.length - 1;
        const result = event.results[last];

        if (result.isFinal) {
          let finalText = result[0].transcript.trim();

          // 将首字母大写并添加标点符号
          if (finalText) {
            // 首字母大写
            finalText = finalText.charAt(0).toUpperCase() + finalText.slice(1);
            // 添加标点符号
            finalText = addPunctuation(finalText);

            console.log("🎤 Speech recognized (final):", finalText);

            // 创建新的字幕条目
            const newCaption: CaptionEntry = {
              speaker: displayName,
              text: finalText,
              timestamp: Date.now(),
              uid: uid || "unknown",
            };

            setCaptions((prev) => [...prev, newCaption]);

            // 滚动到底部
            if (transcriptRef.current) {
              transcriptRef.current.scrollTop =
                transcriptRef.current.scrollHeight;
            }
          }
        } else {
          // 可选：处理非最终结果
          console.log("🎤 Speech recognized (interim):", result[0].transcript);
        }
      };

      // 处理错误
      recognitionInstance.onerror = (event: SpeechRecognitionError) => {
        console.error("Speech recognition error:", event.error);
        if (event.error === "no-speech") {
          console.log("No speech detected");
        }
      };

      // 处理识别结束
      recognitionInstance.onend = () => {
        console.log("Speech recognition ended");
        // 如果仍然在转录模式，重新启动
        if (transcribing) {
          console.log("Restarting speech recognition...");
          recognitionInstance.start();
        }
      };

      // 启动识别
      recognitionInstance.start();
      console.log("🎙️ Started speech recognition");
      setRecognition(recognitionInstance);
      setTranscribing(true);
    } catch (error) {
      console.error("Failed to start speech recognition:", error);
      alert("Failed to start speech recognition");
    }
  };

  // 停止字幕识别
  const stopCaptions = () => {
    if (recognition) {
      recognition.stop();
      setRecognition(null);
    }
    setTranscribing(false);
    console.log("🛑 Stopped speech recognition");
  };

  // Handle window close/refresh
  useEffect(() => {
    const handleBeforeUnload = async (e: BeforeUnloadEvent) => {
      e.preventDefault();
      if (recognition) {
        recognition.stop();
      }
      await handleLeave();
      e.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (recognition) {
        recognition.stop();
      }
    };
  }, [sessionId, uid, recognition]);

  // Initialize session
  useEffect(() => {
    const initializeSession = async () => {
      try {
        if (!channel || !uid) {
          setError("Missing required parameters");
          return;
        }

        // Get session ID from channel code
        const { data: session, error: sessionError } = await supabase
          .from("sessions")
          .select("id")
          .eq("session_code", channel)
          .single();

        if (sessionError || !session) {
          setError("Session not found");
          return;
        }

        setSessionId(session.id);
        const { data: me, error: meError } = await supabase
          .from("participants")
          .select("agora_uid")
          .eq("session_id", session.id)
          .eq("user_id", uid)
          .single();

        if (meError || !me?.agora_uid) {
          setError("Failed to get your agora_uid");
          return;
        }

        const myAgoraUid = me.agora_uid;

        // Auto-join if specified
        if (autoJoin && agoraReady) {
          console.log(
            `participant [${uid}] Auto-joining Agora channel with Agora UID: ${myAgoraUid}`
          );

          await joinChannel(channel, myAgoraUid);
          console.log("✅ Successfully joined Agora channel!");
        }

        setLoading(false);
      } catch (err) {
        console.error("Error initializing session:", err);
        setError("Failed to initialize session");
      }
    };

    initializeSession();
  }, [channel, uid, autoJoin, agoraReady]);

  // Fetch participants including AI
  useEffect(() => {
    const fetchParticipants = async () => {
      if (!sessionId) return;

      const { data, error } = await supabase
        .from("participants")
        .select("user_id, agora_uid, is_ai")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Error fetching participants:", error);
        return;
      }

      // Assign display names (A, B, C, D) to participants
      const displayNames = ["A", "B", "C", "D"];
      const participantsWithNames = data.map((participant, index) => ({
        ...participant,
        user_id: participant.user_id || `ai-${index}`,
        display_name: displayNames[index] || "Unknown",
      }));

      setParticipants(participantsWithNames);
    };

    fetchParticipants();
  }, [sessionId, supabase]);

  const [hasMarkedReady, setHasMarkedReady] = useState(false);
  const [subscribed, setSubscribed] = useState(false);

  const checkStatus = async () => {
    if (hasStartedDiscussionRef.current) return;
    const { data, error } = await supabase
      .from("sessions")
      .select("status, discussion_start_time")
      .eq("id", sessionId)
      .single();

    if (error) {
      console.error("❌ Failed to fetch session status:", error);
      return;
    }

    if (data?.status === "discussion" && data.discussion_start_time) {
      console.log("📦 Session already in discussion mode, setting up timer...");
      setDiscussionStartTime(data.discussion_start_time);
      setAllReady(true);

      if (!recording) {
        await startRecording();
        hasStartedDiscussionRef.current = true;
      }
    }
  };

  useEffect(() => {
    if (hasStartedDiscussionRef.current) return;
    if (!sessionId || !uid || !localVideoTrack || hasMarkedReady || !subscribed)
      return;

    const realUsers = participants.filter((p) => !p.is_ai);
    const allRealUsers = realUsers.map((p) => String(p.agora_uid));
    const currentRemoteRealUsers = remoteUsers
      .map((u) => String(u.uid))
      .filter((remoteUid) => allRealUsers.includes(remoteUid));

    const hasAllRemote =
      currentRemoteRealUsers.length + 1 === allRealUsers.length;

    if (hasAllRemote) {
      console.log("✅ All real users are connected. Sending mark-ready...");

      fetch("/api/session/mark-ready", {
        method: "POST",
        body: JSON.stringify({
          session_id: sessionId,
          user_id: uid,
        }),
        headers: {
          "Content-Type": "application/json",
        },
      })
        .then((res) => {
          if (!res.ok) throw new Error("Failed to mark ready");
          console.log("📬 Mark-ready sent");
          setHasMarkedReady(true);
        })
        .catch((err) => {
          console.error("❌ Failed to mark ready:", err);
        });
    }
  }, [
    remoteUsers,
    localVideoTrack,
    participants,
    sessionId,
    uid,
    hasMarkedReady,
    subscribed,
  ]);

  useEffect(() => {
    if (!sessionId) return;

    const channel = supabase.channel(`session_status_${sessionId}`);

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log("✅ Subscribed to session status channel");
        // 订阅完成后才允许 mark-ready
        setSubscribed(true);

        // 主动 checkStatus 防漏
        checkStatus();
      }
    });

    channel.on("broadcast", { event: "status" }, async (payload) => {
      if (payload.payload.status === "ready") {
        const startTime = payload.payload.discussion_start_time;
        console.log("🎉 All participants are ready!");
        console.log("🕒 Discussion started at:", startTime);
        setDiscussionStartTime(startTime);

        if (!recording) {
          await startRecording();
          hasStartedDiscussionRef.current = true;
        }

        setAllReady(true);
      }
    });

    return () => {
      channel.unsubscribe();
    };
  }, [sessionId]);

  // 确保在页面卸载前停止语音识别
  useEffect(() => {
    return () => {
      if (recognition) {
        recognition.stop();
      }
    };
  }, [recognition]);

  // 禁用导航栏
  useEffect(() => {
    const style = document.createElement("style");
    style.innerHTML = `
      nav, nav *, header, header * {
        pointer-events: none !important;
        opacity: 0.5 !important;
      }
    `;
    document.head.appendChild(style);

    // 防止意外刷新页面
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    // 清理函数
    return () => {
      document.head.removeChild(style);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  if (loading) {
    return (
      <div className="fixed inset-0 bg-[#f5f7fa] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-blue-600 mb-4"></div>
          <p className="text-gray-600">Joining discussion...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 bg-[#f5f7fa] flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={() => router.replace("/")}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg"
          >
            Return to Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f5f7fa]">
      <div className="max-w-7xl mx-auto px-4 py-2">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-3xl font-bold">Discussion Room</h1>
          {allReady ? (
            <div className="p-3 bg-green-100 text-green-800 rounded shadow text-center font-medium">
              ✅ All participants are ready. You may begin speaking.
            </div>
          ) : (
            <div className="p-3 bg-yellow-100 text-yellow-800 rounded shadow text-center font-medium">
              ⏳ Waiting for all participants to be ready...
            </div>
          )}
          {allReady && <CountdownDisplay timeLeft={timeLeft} />}
        </div>

        {/* Participants list */}
        <div className="flex items-center space-x-3 mb-3">
          <h2 className="text-lg font-semibold whitespace-nowrap">
            Participants
          </h2>
          <div className="flex flex-wrap gap-2">
            {participants.map((participant) => (
              <div
                key={participant.user_id}
                className="flex items-center bg-white rounded-lg p-1.5 shadow-sm"
              >
                {participant.is_ai ? (
                  <div className="w-6 h-6 bg-blue-100 rounded-full flex items-center justify-center mr-1.5">
                    <svg
                      className="w-4 h-4 text-blue-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                      />
                    </svg>
                  </div>
                ) : (
                  <div className="w-6 h-6 bg-gray-100 rounded-full flex items-center justify-center mr-1.5">
                    <svg
                      className="w-4 h-4 text-gray-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                      />
                    </svg>
                  </div>
                )}
                <span className="text-gray-700 text-sm">
                  {participant.display_name}
                  {participant.is_ai && " (AI)"}
                  {participant.user_id === uid && " (You)"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Video grid - 移动到更上方 */}
        <div className="grid grid-cols-2 gap-3 mb-4 mt-1">
          {/* Local video */}
          <div className="aspect-video bg-gray-800 rounded-lg overflow-hidden relative">
            {localVideoTrack && (
              <div
                className="w-full h-full"
                ref={(el) => {
                  if (el && !el.hasChildNodes()) {
                    localVideoTrack.play(el);
                  }
                }}
              />
            )}
            <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 rounded text-sm">
              {displayName} (You)
            </div>
          </div>

          {/* Remote videos */}
          {remoteUsers.map((user: IAgoraRTCRemoteUser) => (
            <div
              key={user.uid}
              className="aspect-video bg-gray-800 rounded-lg overflow-hidden relative"
            >
              {user.videoTrack && (
                <div
                  className="w-full h-full"
                  ref={(el) => {
                    if (el && !el.hasChildNodes()) {
                      console.log(`🎥 Playing video for user: ${user.uid}`);
                      try {
                        user.videoTrack?.play(el);
                      } catch (error) {
                        console.error(
                          `❌ Error playing video for user ${user.uid}:`,
                          error
                        );
                      }
                    }
                  }}
                />
              )}
              <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 rounded text-sm">
                {participants.find(
                  (p) => String(p.agora_uid) === String(user.uid)
                )?.display_name || "Unknown"}
                {!user.videoTrack && " (Video Off)"}
              </div>
            </div>
          ))}

          {/* AI Participants (static icons) */}
          {participants
            .filter((p) => p.is_ai)
            .map((ai) => (
              <div
                key={ai.user_id}
                className="aspect-video bg-gray-800 rounded-lg overflow-hidden relative flex items-center justify-center"
              >
                <div className="text-center">
                  <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg
                      className="w-12 h-12 text-blue-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                      />
                    </svg>
                  </div>
                  <div className="text-white text-lg font-medium">
                    {ai.display_name} (AI)
                  </div>
                </div>
              </div>
            ))}
        </div>

        {/* 字幕区域 */}
        {transcribing && (
          <div className="mt-5">
            <h2 className="text-lg font-semibold mb-2">Live Captions</h2>
            <div
              ref={transcriptRef}
              className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm bg-white p-4 rounded-lg shadow-sm border border-gray-200"
            >
              {captions.length > 0 ? (
                captions.map((caption, index) => (
                  <div key={index} className="mb-2">
                    <span className="font-bold text-blue-600">
                      {caption.speaker}:{" "}
                    </span>
                    <span className="text-gray-800">{caption.text}</span>
                    <span className="text-xs text-gray-400 ml-2">
                      {new Date(caption.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-gray-500 italic">
                  Start speaking to see captions appear here...
                </p>
              )}
            </div>
          </div>
        )}

        {/* Caption Control Button - Fixed Position */}
        <div className="fixed bottom-6 right-6">
          {!transcribing ? (
            <button
              onClick={startCaptions}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg shadow-lg hover:bg-blue-700 transition-colors"
            >
              Start Caption
            </button>
          ) : (
            <button
              onClick={stopCaptions}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg shadow-lg hover:bg-blue-600 transition-colors"
            >
              Stop Caption
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// 导出带有 Suspense 的组件
export default function DiscussionClient() {
  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 bg-[#f5f7fa] flex items-center justify-center">
          <div className="flex flex-col items-center">
            <div className="w-16 h-16 border-t-4 border-blue-600 border-solid rounded-full animate-spin"></div>
            <div className="mt-4 text-lg text-blue-600 font-medium">
              Loading...
            </div>
          </div>
        </div>
      }
    >
      <DiscussionClientContent />
    </Suspense>
  );
}
