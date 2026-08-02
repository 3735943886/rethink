export type ClipMessage<Cmd = string, Payload = unknown> = {
    mid: number
    did: string
    kind: string
    cmd: Cmd
    rssi?: number
    fs?: string
    data: Payload
    type: number
}

/*
 * A clip message as it arrived, rather than as this codebase would have written it.
 *
 * Deliberately looser than ClipMessage: the cloud does not fill in every field an appliance does - an
 * acknowledgement carries no `kind` - and a message being carried across the bridge unchanged must not
 * have to satisfy a type describing the other direction.
 */
export type ClipEnvelope = { cmd: string; type?: number; data?: unknown; [key: string]: unknown }

export type DeployPayload = {
    appInfo: {
        modelName: string
        modelLanguage: string
        softVer: string
        ruleVer: string
        countryCode: string
        subCountryCode: string
        appVersion: string
        modemType: string
        regionalCode: string
        timezone: string
        svcCode: string
        HomeApSsid: string
        DeviceType: string
        protocolVer?: string
        // and some other fields yadda yadda
        [key: string]: unknown
    }
    // present in real device deploys alongside appInfo; carries provisioningKey/version
    platformInfo?: { provisioningKey?: string; version?: string; [key: string]: unknown }
    // boot/wifi diagnostics the device tacks on; we don't forward these upstream
    [key: string]: unknown
}

export type ClipDeployMessage = ClipMessage<'preDeploy' | 'deploy', DeployPayload>
