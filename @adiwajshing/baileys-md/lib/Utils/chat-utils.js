"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatModificationToAppPatch = exports.decodePatches = exports.decodeSyncdSnapshot = exports.downloadExternalPatch = exports.downloadExternalBlob = exports.extractSyncdPatches = exports.decodeSyncdPatch = exports.decodeSyncdMutations = exports.encodeSyncdPatch = exports.newLTHashState = void 0;
const boom_1 = require("@hapi/boom");
const crypto_1 = require("./crypto");
const WAProto_1 = require("../../WAProto");
const lt_hash_1 = require("./lt-hash");
const WABinary_1 = require("../WABinary");
const generics_1 = require("./generics");
const messages_media_1 = require("./messages-media");
const mutationKeys = (keydata) => {
    const expanded = (0, crypto_1.hkdf)(keydata, 160, { info: 'WhatsApp Mutation Keys' });
    return {
        indexKey: expanded.slice(0, 32),
        valueEncryptionKey: expanded.slice(32, 64),
        valueMacKey: expanded.slice(64, 96),
        snapshotMacKey: expanded.slice(96, 128),
        patchMacKey: expanded.slice(128, 160)
    };
};
const generateMac = (operation, data, keyId, key) => {
    const getKeyData = () => {
        let r;
        switch (operation) {
            case WAProto_1.proto.SyncdMutation.SyncdMutationSyncdOperation.SET:
                r = 0x01;
                break;
            case WAProto_1.proto.SyncdMutation.SyncdMutationSyncdOperation.REMOVE:
                r = 0x02;
                break;
        }
        const buff = Buffer.from([r]);
        return Buffer.concat([buff, Buffer.from(keyId, 'base64')]);
    };
    const keyData = getKeyData();
    const last = Buffer.alloc(8); // 8 bytes
    last.set([keyData.length], last.length - 1);
    const total = Buffer.concat([keyData, data, last]);
    const hmac = (0, crypto_1.hmacSign)(total, key, 'sha512');
    return hmac.slice(0, 32);
};
const to64BitNetworkOrder = function (e) {
    const t = new ArrayBuffer(8);
    new DataView(t).setUint32(4, e, !1);
    return Buffer.from(t);
};
const makeLtHashGenerator = ({ indexValueMap, hash }) => {
    indexValueMap = { ...indexValueMap };
    const addBuffs = [];
    const subBuffs = [];
    return {
        mix: ({ indexMac, valueMac, operation }) => {
            const indexMacBase64 = Buffer.from(indexMac).toString('base64');
            const prevOp = indexValueMap[indexMacBase64];
            if (operation === WAProto_1.proto.SyncdMutation.SyncdMutationSyncdOperation.REMOVE) {
                if (!prevOp) {
                    throw new boom_1.Boom('tried remove, but no previous op', { data: { indexMac, valueMac } });
                }
                // remove from index value mac, since this mutation is erased
                delete indexValueMap[indexMacBase64];
            }
            else {
                addBuffs.push(new Uint8Array(valueMac).buffer);
                // add this index into the history map
                indexValueMap[indexMacBase64] = { valueMac };
            }
            if (prevOp) {
                subBuffs.push(new Uint8Array(prevOp.valueMac).buffer);
            }
        },
        finish: () => {
            const result = lt_hash_1.LT_HASH_ANTI_TAMPERING.subtractThenAdd(new Uint8Array(hash).buffer, addBuffs, subBuffs);
            const buffer = Buffer.from(result);
            return {
                hash: buffer,
                indexValueMap
            };
        }
    };
};
const generateSnapshotMac = (lthash, version, name, key) => {
    const total = Buffer.concat([
        lthash,
        to64BitNetworkOrder(version),
        Buffer.from(name, 'utf-8')
    ]);
    return (0, crypto_1.hmacSign)(total, key, 'sha256');
};
const generatePatchMac = (snapshotMac, valueMacs, version, type, key) => {
    const total = Buffer.concat([
        snapshotMac,
        ...valueMacs,
        to64BitNetworkOrder(version),
        Buffer.from(type, 'utf-8')
    ]);
    return (0, crypto_1.hmacSign)(total, key);
};
const newLTHashState = () => ({ version: 0, hash: Buffer.alloc(128), indexValueMap: {} });
exports.newLTHashState = newLTHashState;
const encodeSyncdPatch = async ({ type, index, syncAction, apiVersion, operation }, myAppStateKeyId, state, keys) => {
    const key = !!myAppStateKeyId ? await keys.getAppStateSyncKey(myAppStateKeyId) : undefined;
    if (!key) {
        throw new boom_1.Boom(`myAppStateKey ("${myAppStateKeyId}") not present`, { statusCode: 404 });
    }
    const encKeyId = Buffer.from(myAppStateKeyId, 'base64');
    state = { ...state, indexValueMap: { ...state.indexValueMap } };
    const indexBuffer = Buffer.from(JSON.stringify(index));
    const dataProto = WAProto_1.proto.SyncActionData.fromObject({
        index: indexBuffer,
        value: syncAction,
        padding: new Uint8Array(0),
        version: apiVersion
    });
    const encoded = WAProto_1.proto.SyncActionData.encode(dataProto).finish();
    const keyValue = mutationKeys(key.keyData);
    const encValue = (0, crypto_1.aesEncrypt)(encoded, keyValue.valueEncryptionKey);
    const valueMac = generateMac(operation, encValue, encKeyId, keyValue.valueMacKey);
    const indexMac = (0, crypto_1.hmacSign)(indexBuffer, keyValue.indexKey);
    // update LT hash
    const generator = makeLtHashGenerator(state);
    generator.mix({ indexMac, valueMac, operation });
    Object.assign(state, generator.finish());
    state.version += 1;
    const snapshotMac = generateSnapshotMac(state.hash, state.version, type, keyValue.snapshotMacKey);
    const patch = {
        patchMac: generatePatchMac(snapshotMac, [valueMac], state.version, type, keyValue.patchMacKey),
        snapshotMac: snapshotMac,
        keyId: { id: encKeyId },
        mutations: [
            {
                operation: operation,
                record: {
                    index: {
                        blob: indexMac
                    },
                    value: {
                        blob: Buffer.concat([encValue, valueMac])
                    },
                    keyId: { id: encKeyId }
                }
            }
        ]
    };
    const base64Index = indexMac.toString('base64');
    state.indexValueMap[base64Index] = { valueMac };
    return { patch, state };
};
exports.encodeSyncdPatch = encodeSyncdPatch;
const decodeSyncdMutations = async (msgMutations, initialState, getAppStateSyncKey, validateMacs) => {
    const keyCache = {};
    const getKey = async (keyId) => {
        const base64Key = Buffer.from(keyId).toString('base64');
        let key = keyCache[base64Key];
        if (!key) {
            const keyEnc = await getAppStateSyncKey(base64Key);
            if (!keyEnc) {
                throw new boom_1.Boom(`failed to find key "${base64Key}" to decode mutation`, { statusCode: 500, data: { msgMutations } });
            }
            const result = mutationKeys(keyEnc.keyData);
            keyCache[base64Key] = result;
            key = result;
        }
        return key;
    };
    const ltGenerator = makeLtHashGenerator(initialState);
    const mutations = [];
    // indexKey used to HMAC sign record.index.blob
    // valueEncryptionKey used to AES-256-CBC encrypt record.value.blob[0:-32]
    // the remaining record.value.blob[0:-32] is the mac, it the HMAC sign of key.keyId + decoded proto data + length of bytes in keyId
    for (const msgMutation of msgMutations) {
        // if it's a syncdmutation, get the operation property
        // otherwise, if it's only a record -- it'll be a SET mutation
        const operation = 'operation' in msgMutation ? msgMutation.operation : WAProto_1.proto.SyncdMutation.SyncdMutationSyncdOperation.SET;
        const record = ('record' in msgMutation && !!msgMutation.record) ? msgMutation.record : msgMutation;
        const key = await getKey(record.keyId.id);
        const content = Buffer.from(record.value.blob);
        const encContent = content.slice(0, -32);
        const ogValueMac = content.slice(-32);
        if (validateMacs) {
            const contentHmac = generateMac(operation, encContent, record.keyId.id, key.valueMacKey);
            if (Buffer.compare(contentHmac, ogValueMac) !== 0) {
                throw new boom_1.Boom('HMAC content verification failed');
            }
        }
        const result = (0, crypto_1.aesDecrypt)(encContent, key.valueEncryptionKey);
        const syncAction = WAProto_1.proto.SyncActionData.decode(result);
        if (validateMacs) {
            const hmac = (0, crypto_1.hmacSign)(syncAction.index, key.indexKey);
            if (Buffer.compare(hmac, record.index.blob) !== 0) {
                throw new boom_1.Boom('HMAC index verification failed');
            }
        }
        const indexStr = Buffer.from(syncAction.index).toString();
        const mutation = {
            syncAction,
            index: JSON.parse(indexStr),
            indexMac: record.index.blob,
            valueMac: ogValueMac,
            operation: operation,
        };
        mutations.push(mutation);
        ltGenerator.mix(mutation);
    }
    return { mutations, ...ltGenerator.finish() };
};
exports.decodeSyncdMutations = decodeSyncdMutations;
const decodeSyncdPatch = async (msg, name, initialState, getAppStateSyncKey, validateMacs) => {
    if (validateMacs) {
        const base64Key = Buffer.from(msg.keyId.id).toString('base64');
        const mainKeyObj = await getAppStateSyncKey(base64Key);
        const mainKey = mutationKeys(mainKeyObj.keyData);
        const mutationmacs = msg.mutations.map(mutation => mutation.record.value.blob.slice(-32));
        const patchMac = generatePatchMac(msg.snapshotMac, mutationmacs, (0, generics_1.toNumber)(msg.version.version), name, mainKey.patchMacKey);
        if (Buffer.compare(patchMac, msg.patchMac) !== 0) {
            throw new boom_1.Boom('Invalid patch mac');
        }
    }
    const result = await (0, exports.decodeSyncdMutations)(msg.mutations, initialState, getAppStateSyncKey, validateMacs);
    return result;
};
exports.decodeSyncdPatch = decodeSyncdPatch;
const extractSyncdPatches = async (result) => {
    const syncNode = (0, WABinary_1.getBinaryNodeChild)(result, 'sync');
    const collectionNodes = (0, WABinary_1.getBinaryNodeChildren)(syncNode, 'collection');
    const final = {};
    await Promise.all(collectionNodes.map(async (collectionNode) => {
        const patchesNode = (0, WABinary_1.getBinaryNodeChild)(collectionNode, 'patches');
        const patches = (0, WABinary_1.getBinaryNodeChildren)(patchesNode || collectionNode, 'patch');
        const snapshotNode = (0, WABinary_1.getBinaryNodeChild)(collectionNode, 'snapshot');
        const syncds = [];
        const name = collectionNode.attrs.name;
        let snapshot = undefined;
        if (snapshotNode && !!snapshotNode.content) {
            if (!Buffer.isBuffer(snapshotNode)) {
                snapshotNode.content = Buffer.from(Object.values(snapshotNode.content));
            }
            const blobRef = WAProto_1.proto.ExternalBlobReference.decode(snapshotNode.content);
            const data = await (0, exports.downloadExternalBlob)(blobRef);
            snapshot = WAProto_1.proto.SyncdSnapshot.decode(data);
        }
        for (let { content } of patches) {
            if (content) {
                if (!Buffer.isBuffer(content)) {
                    content = Buffer.from(Object.values(content));
                }
                const syncd = WAProto_1.proto.SyncdPatch.decode(content);
                if (!syncd.version) {
                    syncd.version = { version: +collectionNode.attrs.version + 1 };
                }
                syncds.push(syncd);
            }
        }
        final[name] = { patches: syncds, snapshot };
    }));
    return final;
};
exports.extractSyncdPatches = extractSyncdPatches;
const downloadExternalBlob = async (blob) => {
    const stream = await (0, messages_media_1.downloadContentFromMessage)(blob, 'md-app-state');
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
};
exports.downloadExternalBlob = downloadExternalBlob;
const downloadExternalPatch = async (blob) => {
    const buffer = await (0, exports.downloadExternalBlob)(blob);
    const syncData = WAProto_1.proto.SyncdMutations.decode(buffer);
    return syncData;
};
exports.downloadExternalPatch = downloadExternalPatch;
const decodeSyncdSnapshot = async (name, snapshot, getAppStateSyncKey, validateMacs = true) => {
    const newState = (0, exports.newLTHashState)();
    newState.version = (0, generics_1.toNumber)(snapshot.version.version);
    const records = snapshot.records;
    const ltGenerator = makeLtHashGenerator(newState);
    for (const { index, value } of records) {
        const valueMac = value.blob.slice(-32);
        ltGenerator.mix({ indexMac: index.blob, valueMac, operation: 0 });
    }
    Object.assign(newState, ltGenerator.finish());
    if (validateMacs) {
        const base64Key = Buffer.from(snapshot.keyId.id).toString('base64');
        const keyEnc = await getAppStateSyncKey(base64Key);
        if (!keyEnc) {
            throw new boom_1.Boom(`failed to find key "${base64Key}" to decode mutation`, { statusCode: 500 });
        }
        const result = mutationKeys(keyEnc.keyData);
        const computedSnapshotMac = generateSnapshotMac(newState.hash, newState.version, name, result.snapshotMacKey);
        if (Buffer.compare(snapshot.mac, computedSnapshotMac) !== 0) {
            throw new boom_1.Boom(`failed to verify LTHash at ${newState.version} of ${name} from snapshot`, { statusCode: 500 });
        }
    }
    return newState;
};
exports.decodeSyncdSnapshot = decodeSyncdSnapshot;
const decodePatches = async (name, syncds, initial, getAppStateSyncKey, validateMacs = true) => {
    const successfulMutations = [];
    const newState = {
        ...initial,
        indexValueMap: { ...initial.indexValueMap }
    };
    for (const syncd of syncds) {
        const { version, keyId, snapshotMac } = syncd;
        if (syncd.externalMutations) {
            const ref = await (0, exports.downloadExternalPatch)(syncd.externalMutations);
            syncd.mutations.push(...ref.mutations);
        }
        newState.version = (0, generics_1.toNumber)(version.version);
        const decodeResult = await (0, exports.decodeSyncdPatch)(syncd, name, newState, getAppStateSyncKey, validateMacs);
        newState.hash = decodeResult.hash;
        newState.indexValueMap = decodeResult.indexValueMap;
        successfulMutations.push(...decodeResult.mutations);
        if (validateMacs) {
            const base64Key = Buffer.from(keyId.id).toString('base64');
            const keyEnc = await getAppStateSyncKey(base64Key);
            if (!keyEnc) {
                throw new boom_1.Boom(`failed to find key "${base64Key}" to decode mutation`);
            }
            const result = mutationKeys(keyEnc.keyData);
            const computedSnapshotMac = generateSnapshotMac(newState.hash, newState.version, name, result.snapshotMacKey);
            if (Buffer.compare(snapshotMac, computedSnapshotMac) !== 0) {
                throw new boom_1.Boom(`failed to verify LTHash at ${newState.version} of ${name}`);
            }
        }
    }
    return {
        newMutations: successfulMutations,
        state: newState
    };
};
exports.decodePatches = decodePatches;
const chatModificationToAppPatch = (mod, jid, lastMessages) => {
    const OP = WAProto_1.proto.SyncdMutation.SyncdMutationSyncdOperation;
    const getMessageRange = () => {
        if (!(lastMessages === null || lastMessages === void 0 ? void 0 : lastMessages.length)) {
            throw new boom_1.Boom('Expected last message to be not from me', { statusCode: 400 });
        }
        const lastMsg = lastMessages[lastMessages.length - 1];
        if (lastMsg.key.fromMe) {
            throw new boom_1.Boom('Expected last message in array to be not from me', { statusCode: 400 });
        }
        const messageRange = {
            lastMessageTimestamp: lastMsg === null || lastMsg === void 0 ? void 0 : lastMsg.messageTimestamp,
            messages: lastMessages
        };
        return messageRange;
    };
    let patch;
    if ('mute' in mod) {
        patch = {
            syncAction: {
                muteAction: {
                    muted: !!mod.mute,
                    muteEndTimestamp: mod.mute || undefined
                }
            },
            index: ['mute', jid],
            type: 'regular_high',
            apiVersion: 2,
            operation: OP.SET
        };
    }
    else if ('archive' in mod) {
        patch = {
            syncAction: {
                archiveChatAction: {
                    archived: !!mod.archive,
                    messageRange: getMessageRange()
                }
            },
            index: ['archive', jid],
            type: 'regular_low',
            apiVersion: 3,
            operation: OP.SET
        };
    }
    else if ('markRead' in mod) {
        patch = {
            syncAction: {
                markChatAsReadAction: {
                    read: mod.markRead,
                    messageRange: getMessageRange()
                }
            },
            index: ['markChatAsRead', jid],
            type: 'regular_low',
            apiVersion: 3,
            operation: OP.SET
        };
    }
    else if ('clear' in mod) {
        if (mod.clear === 'all') {
            throw new boom_1.Boom('not supported');
        }
        else {
            const key = mod.clear.message;
            patch = {
                syncAction: {
                    deleteMessageForMeAction: {
                        deleteMedia: false
                    }
                },
                index: ['deleteMessageForMe', jid, key.id, key.fromMe ? '1' : '0', '0'],
                type: 'regular_high',
                apiVersion: 3,
                operation: OP.SET
            };
        }
    }
    else if ('pin' in mod) {
        patch = {
            syncAction: {
                pinAction: {
                    pinned: !!mod.pin
                }
            },
            index: ['pin_v1', jid],
            type: 'regular_low',
            apiVersion: 5,
            operation: OP.SET
        };
    }
    else {
        throw new boom_1.Boom('not supported');
    }
    patch.syncAction.timestamp = Date.now();
    return patch;
};
exports.chatModificationToAppPatch = chatModificationToAppPatch;
