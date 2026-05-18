import { useRouter } from "next/router";
import { useEffect, useRef, useState } from "react";
import {
  PublishTransport,
  SubscribeTransport,
  simulcastEncodings,
  rfc8840Candidate,
} from "rheomesh";

const peerConnectionConfig: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export default function Room() {
  const router = useRouter();
  const host = `http://localhost:${process.env.NEXT_PUBLIC_SERVER_PORT || "4000"}`;

  const [room, setRoom] = useState("");
  const [localVideo, setLocalVideo] = useState<MediaStream | null>(null);
  const [recevingVideo, setRecevingVideo] = useState<{
    [publisherId: string]: MediaStream;
  }>({});
  const [recevingAudio, setRecevingAudio] = useState<{
    [publisherId: string]: MediaStream;
  }>({});
  const [subscriberIds, setSubscriberIds] = useState<Array<string>>([]);

  const sendingVideoRef = useRef<HTMLVideoElement>(null);
  const publishTransport = useRef<PublishTransport | null>(null);
  const subscribeTransport = useRef<SubscribeTransport | null>(null);
  const publishers = useRef<Array<string>>([]);
  const sessionId = useRef<string | null>(null);
  const etag = useRef<string | null>(null);
  const subscribeCandidate = useRef<Array<RTCIceCandidate>>([]);

  useEffect(() => {
    if (router.query.room) {
      setRoom(router.query.room as string);

      (async () => {
        const response = await fetch(
          `${host}/rooms/${router.query.room}/join`,
          { method: "POST" },
        );
        console.debug("Join room response:", response);
        if (response.ok) {
          const json = await response.json();
          sessionId.current = json.session_id;
          publishers.current = json.publisher_ids;
          startPublishPeer();
          startSubscribePeer();
        }
      })();
    }
  }, [router.query.room]);

  /** publisher with WHIP **/
  const startPublishPeer = () => {
    if (!publishTransport.current) {
      publishTransport.current = new PublishTransport(
        peerConnectionConfig,
        true,
      );
      publishTransport.current.on(
        "icecandidate",
        (candidate: RTCIceCandidate) => {
          if (sessionId.current && etag.current) {
            const fragment = rfc8840Candidate(candidate);
            fetch(`${host}/whip/${sessionId.current}`, {
              method: "PATCH",
              body: fragment,
              headers: {
                "Content-Type": "application/trickle-ice-sdpfrag",
                "If-Match": etag.current!,
              },
            }).then((response) => {
              if (response.ok && response.status === 204) {
                console.debug("ICE candidate sent successfully");
              } else if (response.ok) {
                console.warn("Unexpected response status:", response.status);
              } else {
                console.error(
                  "Failed to send ICE candidate:",
                  response.statusText,
                );
              }
            });
          }
        },
      );
    }
  };

  const capture = async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });

    if (sendingVideoRef.current) {
      sendingVideoRef.current.srcObject = stream;
    }
    await publish(stream);
    setLocalVideo(stream);
  };

  const publish = async (stream: MediaStream) => {
    stream.getTracks().forEach(async (track) => {
      const publisher = await publishTransport.current!.publish(track, {
        encodings: simulcastEncodings(),
      });
      const response = await fetch(`${host}/whip/${sessionId.current}`, {
        method: "POST",
        body: publisher.offer.sdp,
        headers: { "Content-Type": "application/sdp" },
      });
      if (!response.ok) {
        console.error("Failed to publish track:", response.statusText);
        return;
      }
      etag.current = response.headers.get("Etag");
      console.debug("Received Etag:", etag.current);
      console.debug("WHIP response:", response);
      const sdp = new RTCSessionDescription({
        type: "answer",
        sdp: await response.text(),
      });
      await publishTransport.current!.setAnswer(sdp);
    });
  };

  const closePublish = async () => {
    localVideo?.getTracks().forEach((track) => {
      track.stop();
    });
    setLocalVideo(null);
    publishTransport.current?.close();
    publishTransport.current = null;
    await fetch(`${host}/whip/${sessionId.current}`, {
      method: "DELETE",
    });
  };

  /** subscriber with WHEP **/
  const startSubscribePeer = () => {
    if (!subscribeTransport.current) {
      subscribeTransport.current = new SubscribeTransport(peerConnectionConfig);
      subscribeTransport.current.on(
        "icecandidate",
        (candidate: RTCIceCandidate) => {
          subscribeCandidate.current.push(candidate);
        },
      );
    }
  };

  const subscribe = async () => {
    publishers.current.forEach(async (id) => {
      await trySubscribe(id);
    });
  };

  const trySubscribe = async (publisherId: string) => {
    if (!subscribeTransport.current) return;
    const empty = await subscribeTransport.current.generateWHEP();
    const response = await fetch(
      `${host}/whep/${sessionId.current}/${publisherId}`,
      {
        method: "POST",
        body: empty.sdp,
        headers: { "Content-Type": "application/sdp" },
      },
    );
    if (!response.ok) {
      console.error("Failed to subscribe:", response.statusText);
      return;
    }
    etag.current = response.headers.get("Etag");
    console.debug("Received Etag: ", etag.current);
    console.debug("WHEP response: ", response);
    const sdp = new RTCSessionDescription({
      type: "answer",
      sdp: await response.text(),
    });
    await subscribeTransport.current!.setAnswer(sdp);
    while (subscribeCandidate.current.length > 0) {
      const candidate = subscribeCandidate.current.shift();
      if (candidate && sessionId.current && etag.current) {
        const fragment = rfc8840Candidate(candidate);
        fetch(`${host}/whep/${sessionId.current}`, {
          method: "PATCH",
          body: fragment,
          headers: {
            "Content-Type": "application/trickle-ice-sdpfrag",
            "If-Match": etag.current!,
          },
        }).then((response) => {
          if (response.ok && response.status === 204) {
            console.debug("ICE candidate sent successfully");
          } else if (response.ok) {
            console.warn("Unexpected response status:", response.status);
          } else {
            console.error("Failed to send ICE candidate:", response.statusText);
          }
        });
      }
    }
    const subscriber = await subscribeTransport.current!.subscribe(publisherId);
    const stream = new MediaStream([subscriber.track]);
    if (subscriber.track.kind === "audio") {
      setRecevingAudio((prev) => ({
        ...prev,
        [publisherId]: stream,
      }));
    } else {
      setRecevingVideo((prev) => ({
        ...prev,
        [publisherId]: stream,
      }));
    }
  };

  const closeSubscribe = async () => {
    subscribeTransport.current?.close();
    subscribeTransport.current = null;
    await fetch(`${host}/whep/${sessionId.current}`, {
      method: "DELETE",
    });
  };

  return (
    <div>
      <h1>Room: {room}</h1>
      <div>
        <button id="capture" onClick={capture} disabled={localVideo !== null}>
          Capture
        </button>
        <button id="close_publish" onClick={closePublish}>
          Close publish
        </button>
      </div>
      <h3>Sending Video</h3>
      <video
        autoPlay
        muted
        id="sending-video"
        ref={sendingVideoRef}
        width={480}
      ></video>
      <h3>Receving</h3>
      <button id="subscribe" onClick={subscribe}>
        Subscribe
      </button>
      <button id="close_subscribe" onClick={closeSubscribe}>
        Close subscribe
      </button>
      {Object.keys(recevingVideo).map((key) => (
        <div key={key}>
          {recevingVideo[key] && (
            <video
              id={key}
              muted
              className="receiving-video"
              autoPlay
              ref={(video) => {
                if (video && recevingVideo[key]) {
                  video.srcObject = recevingVideo[key];
                } else {
                  console.warn("video element or track is null");
                }
              }}
              width={480}
            ></video>
          )}
        </div>
      ))}
      {Object.keys(recevingAudio).map((key) => (
        <div key={key}>
          {recevingAudio[key] && (
            <audio
              id={key}
              autoPlay
              controls
              ref={(audio) => {
                if (audio && recevingAudio[key]) {
                  audio.srcObject = recevingAudio[key];
                } else {
                  console.warn("audio element or track is null");
                }
              }}
            ></audio>
          )}
        </div>
      ))}
    </div>
  );
}
