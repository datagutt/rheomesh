//! Per-subscriber RTP header extension id translation.
//!
//! A publisher and a subscriber negotiate header extension ids independently:
//! each is a separate peer connection with its own offer/answer, and an answer
//! may only accept or omit what its offer proposed — it may not renumber it.
//! Browsers enforce that strictly, rejecting the whole session description with
//! "RTP extension ID reassignment not supported".
//!
//! So an SFU cannot impose one canonical numbering by SDP means, and forwarded
//! packets still carry the publisher's ids. Whatever the subscriber negotiated
//! is what it will use to interpret them, which means the ids have to be
//! rewritten on the forwarding path. That is what this module does.
//!
//! Extensions the subscriber did not negotiate are dropped rather than passed
//! through: an unrecognised id would otherwise be read as whichever extension
//! the subscriber happens to have bound to that number.

use std::collections::HashMap;

use webrtc::rtp::header::{EXTENSION_PROFILE_ONE_BYTE, EXTENSION_PROFILE_TWO_BYTE};
use webrtc::rtp_transceiver::rtp_codec::RTCRtpHeaderExtensionParameters;

/// The largest id the one-byte extension header form can express (RFC 8285).
const ONE_BYTE_MAX_ID: u8 = 14;

/// Translates publisher extension ids to a single subscriber's ids.
#[derive(Debug, Clone, Default)]
pub(crate) struct ExtensionTranslator {
    /// publisher id -> subscriber id. Absent means drop.
    map: HashMap<u8, u8>,
    /// True when every mapping is an identity, so packets can be left alone.
    identity: bool,
}

impl ExtensionTranslator {
    /// A translator that leaves every packet alone.
    ///
    /// Used for relayed tracks, where the originating peer connection is on
    /// another server and its negotiated ids are not observable from here.
    pub(crate) fn passthrough() -> Self {
        Self {
            map: HashMap::new(),
            identity: true,
        }
    }

    pub(crate) fn new(
        publisher: &[RTCRtpHeaderExtensionParameters],
        subscriber: &[RTCRtpHeaderExtensionParameters],
    ) -> Self {
        let by_uri: HashMap<&str, isize> = subscriber
            .iter()
            .map(|ext| (ext.uri.as_str(), ext.id))
            .collect();

        let mut map = HashMap::new();
        let mut identity = true;
        for ext in publisher {
            // Ids outside 1..=255 cannot appear in a packet, so a negotiated
            // value outside that range is not something we can translate.
            let Ok(from) = u8::try_from(ext.id) else {
                continue;
            };
            let Some(to) = by_uri.get(ext.uri.as_str()).and_then(|id| u8::try_from(*id).ok())
            else {
                // Subscriber did not negotiate this one: it will be dropped,
                // which is itself a change from passthrough.
                identity = false;
                continue;
            };
            if from != to {
                identity = false;
            }
            map.insert(from, to);
        }

        Self { map, identity }
    }

    /// Rewrites a packet's extension ids in place.
    pub(crate) fn translate(&self, header: &mut webrtc::rtp::header::Header) {
        if self.identity || !header.extension || header.extensions.is_empty() {
            return;
        }

        header.extensions.retain_mut(|ext| match self.map.get(&ext.id) {
            Some(id) => {
                ext.id = *id;
                true
            }
            None => false,
        });

        if header.extensions.is_empty() {
            // Leaving `extension` set with no extensions would marshal an empty
            // extension block, which is legal but pointless; clearing it keeps
            // the packet identical to one that never had extensions.
            header.extension = false;
            header.extensions_padding = 0;
            return;
        }

        // The one-byte form cannot carry an id above 14, so a translation that
        // crosses that boundary has to move the packet to the two-byte form.
        // Going the other way is not forced: two-byte remains valid for small
        // ids, and rewriting profiles more than necessary risks upsetting
        // receivers that key off the profile.
        if header.extension_profile == EXTENSION_PROFILE_ONE_BYTE
            && header.extensions.iter().any(|ext| ext.id > ONE_BYTE_MAX_ID)
        {
            header.extension_profile = EXTENSION_PROFILE_TWO_BYTE;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use webrtc::rtp::header::{Extension, Header};

    fn ext(uri: &str, id: isize) -> RTCRtpHeaderExtensionParameters {
        RTCRtpHeaderExtensionParameters {
            uri: uri.to_owned(),
            id,
        }
    }

    fn header(profile: u16, ids: &[u8]) -> Header {
        Header {
            extension: true,
            extension_profile: profile,
            extensions: ids
                .iter()
                .map(|id| Extension {
                    id: *id,
                    payload: Bytes::from_static(&[0x01]),
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn renumbers_to_the_subscriber_ids() {
        // The case that broke browsers: publisher had mid on 9 and transport-cc
        // on 4, subscriber negotiated 4 and 3 respectively.
        let translator = ExtensionTranslator::new(
            &[ext("urn:ietf:params:rtp-hdrext:sdes:mid", 9), ext("transport-cc", 4)],
            &[ext("urn:ietf:params:rtp-hdrext:sdes:mid", 4), ext("transport-cc", 3)],
        );

        let mut h = header(EXTENSION_PROFILE_ONE_BYTE, &[9, 4]);
        translator.translate(&mut h);
        assert_eq!(h.extensions.iter().map(|e| e.id).collect::<Vec<_>>(), vec![4, 3]);
    }

    #[test]
    fn drops_extensions_the_subscriber_did_not_negotiate() {
        let translator =
            ExtensionTranslator::new(&[ext("a", 1), ext("b", 2)], &[ext("a", 5)]);

        let mut h = header(EXTENSION_PROFILE_ONE_BYTE, &[1, 2]);
        translator.translate(&mut h);
        assert_eq!(h.extensions.iter().map(|e| e.id).collect::<Vec<_>>(), vec![5]);
    }

    #[test]
    fn clears_the_extension_flag_when_nothing_survives() {
        let translator = ExtensionTranslator::new(&[ext("a", 1)], &[ext("b", 1)]);

        let mut h = header(EXTENSION_PROFILE_ONE_BYTE, &[1]);
        translator.translate(&mut h);
        assert!(h.extensions.is_empty());
        assert!(!h.extension);
    }

    #[test]
    fn promotes_to_two_byte_when_an_id_exceeds_the_one_byte_range() {
        let translator = ExtensionTranslator::new(&[ext("a", 3)], &[ext("a", 15)]);

        let mut h = header(EXTENSION_PROFILE_ONE_BYTE, &[3]);
        translator.translate(&mut h);
        assert_eq!(h.extension_profile, EXTENSION_PROFILE_TWO_BYTE);
        assert_eq!(h.extensions[0].id, 15);
    }

    #[test]
    fn identical_maps_are_left_alone() {
        let translator =
            ExtensionTranslator::new(&[ext("a", 1), ext("b", 2)], &[ext("a", 1), ext("b", 2)]);

        let mut h = header(EXTENSION_PROFILE_ONE_BYTE, &[1, 2]);
        translator.translate(&mut h);
        assert_eq!(h.extensions.iter().map(|e| e.id).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(h.extension_profile, EXTENSION_PROFILE_ONE_BYTE);
    }
}
