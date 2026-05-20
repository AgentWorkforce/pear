export default $config({
  app(input) {
    return {
      name: 'pear',
      home: 'aws',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      providers: {
        cloudflare: '6.13.0'
      }
    }
  },
  run() {
    const isProd = $app.stage === 'production'
    const domain = isProd ? 'pear.agentrelay.com' : `${$app.stage}.pear.agentrelay.com`

    const site = new sst.aws.StaticSite('PearReleaseSite', {
      path: 'site',
      domain: {
        name: domain,
        dns: sst.cloudflare.dns({ proxy: true })
      },
      invalidation: {
        wait: isProd
      }
    })

    return {
      siteUrl: site.url,
      installCommand: `curl -fsSL https://${domain}/install.sh | sh`
    }
  }
})
